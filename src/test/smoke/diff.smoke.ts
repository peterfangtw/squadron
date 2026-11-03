/**
 * The counts on a pill, and the editor behind them.
 *
 * The one claim jsdom cannot make. `chat_writes.test.ts` already asserts that a
 * click on `.wnum` posts `openDiff` and that the marks read what they should —
 * what is left is whether the host, given that message, opens a real diff tab
 * with both sides in it. `ui_test_scenarios.md` Step 5 reserves exactly that
 * kind of claim for smoke.
 *
 * **Why the shared fixture card rather than a child of its own.** The
 * transcript these counts are read off is written once in `boot.ts`, in the
 * CLI's own entry shapes, against a working tree `boot.ts` also commits — a
 * second child would need a second copy of both. Since row 71 that card is an
 * owned session like any other, and `fixtureSession()` resumes the planted
 * boot transcript through recovery. It also keeps this out
 * of `session.smoke.ts`'s sequence, which is one session's life in order.
 *
 * The pill needs no ownership: a turn that wrote a file is a reading of the
 * transcript, and the diff is a reading of the working tree.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Locator } from 'playwright-core';
import type { TurnCheckpoint } from '../../core/checkpoint';
import { SCHEMA } from '../../core/record';
import {
  ctx,
  DIFFED,
  homeDir,
  MOVED,
  MOVED_REPO,
  openPanel,
  panel,
  patchSettings,
  section,
  step
} from './boot';
import {
  composer,
  endCard,
  FIXTURE_NAME,
  fixtureSession,
  openDraft,
  pids,
  waitForNewPid
} from './kit';
import { linkDir, testPlatform } from '../helpers';

/** `GIT_*` stripped: the gate runs from the pre-commit hook, which exports
 *  `GIT_DIR` into it, and that beats `-C` — `boot.ts` says the same at length. */
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);

/**
 * Monaco renders its lines without the newlines, so this asks for a fragment
 * rather than equality — and waits, since a re-read is what is being watched.
 *
 * **The spaces are `U+00A0`.** Monaco draws whitespace as non-breaking, so a
 * read of its DOM looks character-for-character like the source and matches no
 * ASCII-space needle at all — a failure whose message prints the two strings
 * as identical. Normalised here rather than in every needle.
 */
async function expectText(where: Locator, want: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const text = ((await where.textContent()) ?? '').replace(/\u00a0/g, ' ');
    if (text.includes(want)) return;
    if (Date.now() > until) {
      assert.fail(`waited ${ms}ms for ${JSON.stringify(want)}, last read ${JSON.stringify(text)}`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
}

section('the diff behind a turn’s counts, in the real IDE', () => {
  step('opens a diff tab for the file a turn wrote', async () => {
    await openPanel();
    await fixtureSession();
    await panel().locator('.card', { hasText: FIXTURE_NAME }).click();

    const num = panel().locator('#thread .wpill .wnum').first();
    await num.waitFor({ timeout: 30_000 });
    // The fixture's Edit against its own committed body: one line replaced and
    // one added, with the shared first line and the trailing empty one trimmed.
    assert.equal((await num.textContent())?.trim(), '+2−1');

    await num.click();

    // The host's own tab, not ours — `vscode.diff` titles it, and the title is
    // the whole claim the pill makes about what it is showing.
    const tab = ctx.page.locator('.tabs-container .tab', { hasText: `${DIFFED} — since HEAD` });
    await tab.waitFor({ timeout: 30_000 });

    // Both sides drawn. A missing right-hand file resolves without throwing and
    // then paints the host's *file not found* over both panes — observed, after
    // a probe reading return values had recorded it as a success. So this asks
    // the window, and asks for the half a broken tab does not draw.
    const before = ctx.page.locator('.monaco-diff-editor .original-in-monaco-diff-editor');
    await before.waitFor({ timeout: 30_000 });

    // Left where the next scenario expects it: a diff tab opened `Beside` adds
    // an editor group, and the board is what every other file starts from.
    await ctx.page.keyboard.press('ControlOrMeta+W');
    await tab.waitFor({ state: 'detached', timeout: 30_000 });
    await openDraft();
  });

  /**
   * The counts are green and red, and nothing below a real host can say whether
   * they are. `--av-green` is a bare `var(--vscode-charts-green)` with no
   * fallback, so a host that does not ship that variable makes the whole
   * declaration invalid at computed-value time and `color` falls back to the
   * inherited muted grey — the monochrome this row deliberately left, arriving
   * back silently with every unit test green. jsdom resolves no `var()` chain
   * against host-injected variables, so it cannot tell the two apart.
   *
   * Channel dominance rather than an exact value: the hue comes from the host's
   * chart palette and moves with the colour theme, and a scenario before this
   * one picks a theme.
   */
  step('paints the counts in the host’s own green and red', async () => {
    await openPanel();
    await fixtureSession();
    await panel().locator('.card', { hasText: FIXTURE_NAME }).click();

    const num = panel().locator('#thread .wpill .wnum').first();
    await num.waitFor({ timeout: 30_000 });

    const colour = (where: Locator) => where.evaluate((el) => getComputedStyle(el).color);
    const [add, del, segment] = await Promise.all([
      colour(num.locator('.add')),
      colour(num.locator('.del')),
      colour(num)
    ]);

    // The failure the fallback would produce: both marks equal to the segment
    // they sit in, and to each other.
    assert.notEqual(add, segment, 'the additions took the segment’s muted colour');
    assert.notEqual(del, segment, 'the deletions took the segment’s muted colour');
    assert.notEqual(add, del);

    const channels = (css: string) => {
      const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).map(Number);
      return { r, g, b };
    };
    const a = channels(add);
    const d = channels(del);
    assert.ok(a.g > a.r && a.g > a.b, `additions are not green: ${add}`);
    assert.ok(d.r > d.g && d.r > d.b, `deletions are not red: ${del}`);

    await openDraft();
  });

  /**
   * The before-image is a claim about `HEAD`, so it goes stale when HEAD moves —
   * and this is the only branch of the row that is neither a pure function nor
   * one call. The provider watches `refs/heads/<branch>` while it has a live
   * document and fires `onDidChange` when the sha moves; the editor was observed
   * to re-read on that, but the watch itself is ours and new.
   *
   * Committing the tree makes HEAD equal the working tree, so the diff that had
   * a change in it should end up with none.
   */
  step('re-reads the before-image when HEAD moves under an open diff', async () => {
    // Its own repository, so moving HEAD is nobody else's problem — `project` is
    // read by the servers line and cut into a worktree by the monorepo fixture.
    const repo = path.join(homeDir(), MOVED_REPO);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { env: CLEAN, stdio: 'ignore' });

    await openPanel();
    await fixtureSession();
    await panel().locator('.card', { hasText: FIXTURE_NAME }).click();
    const num = panel().locator('#thread .wpill', { hasText: MOVED }).locator('.wnum');
    await num.waitFor({ timeout: 30_000 });
    await num.click();

    const tab = ctx.page.locator('.tabs-container .tab', { hasText: `${MOVED} — since HEAD` });
    await tab.waitFor({ timeout: 30_000 });
    const before = ctx.page.locator(
      '.monaco-diff-editor .original-in-monaco-diff-editor .view-lines'
    );
    await before.waitFor({ timeout: 30_000 });
    // What HEAD held when the tab opened.
    await expectText(before, 'q = 2');

    try {
      git('add', MOVED);
      git(
        '-c',
        'user.email=smoke@example.invalid',
        '-c',
        'user.name=smoke',
        'commit',
        '--quiet',
        '-m',
        'move HEAD'
      );
      // The watch reads on its own cadence, so this is a wait rather than an
      // assertion — and it is the whole claim: the pane re-read.
      await expectText(before, 'q = 3', 30_000);
    } finally {
      // Nothing outside this repository is touched, so the reset is only good
      // manners for a re-run against a warm profile.
      git('reset', '--soft', 'HEAD~1');
      git('restore', '--staged', '.');
      // Focused first, then waited for. This runs after a poll of up to 30s, so
      // focus is not guaranteed to still be on the diff — and a stray
      // ControlOrMeta+W would close the panel out from under every later step.
      await tab.click();
      await ctx.page.keyboard.press('ControlOrMeta+W');
      await tab.waitFor({ state: 'detached', timeout: 30_000 });
      await openDraft();
    }
  });

  step(
    'keeps each turn’s baseline after commits, with live files and honest fallback',
    async (t) => {
      const settingsFile = path.join(ctx.profile, 'data', 'User', 'settings.json');
      const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as Record<
        string,
        unknown
      >;
      // Narrow native groups otherwise switch to inline mode and stop painting the original pane.
      await patchSettings({
        'diffEditor.renderSideBySide': true,
        'diffEditor.useInlineViewWhenSpaceIsLimited': false
      });
      t.after(() =>
        patchSettings({
          'diffEditor.renderSideBySide': settings['diffEditor.renderSideBySide'],
          'diffEditor.useInlineViewWhenSpaceIsLimited':
            settings['diffEditor.useInlineViewWhenSpaceIsLimited']
        })
      );
      await openPanel();
      const repo = await fs.mkdtemp(path.join(homeDir(), 'turn-baseline-'));
      const alias = `${repo}-alias`;
      await linkDir(repo, alias);
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repo, ...args], { env: CLEAN, encoding: 'utf8' }).trim();
      const commit = () => {
        git('add', '-A');
        git(
          '-c',
          'user.email=smoke@example.invalid',
          '-c',
          'user.name=smoke',
          'commit',
          '--quiet',
          '-m',
          'baseline fixture'
        );
      };
      const shared = path.join(repo, 'two-turns.txt');
      const aliasTarget = path.join(repo, 'alias-target.txt');
      const aliased = path.join(alias, 'alias-target.txt');
      const empty = path.join(repo, 'empty-before.txt');
      const added = path.join(repo, 'added-later.txt');
      const unavailable = path.join(repo, 'unavailable.txt');
      const malformed = path.join(repo, 'malformed.txt');
      git('init', '--quiet', '--initial-branch=baseline-main');
      await fs.writeFile(shared, 'first baseline\n');
      await fs.writeFile(aliasTarget, 'aliased baseline\n');
      await fs.writeFile(empty, '');
      await fs.writeFile(unavailable, 'fallback at HEAD\n');
      await fs.writeFile(malformed, 'malformed at HEAD\n');
      commit();
      const head = git('rev-parse', 'HEAD');
      const first = git('rev-parse', 'HEAD^{tree}');
      await fs.writeFile(shared, 'second baseline\n');
      git('add', '-A');
      const second = git('write-tree');
      await fs.writeFile(shared, 'committed after both turns\n');
      await fs.writeFile(aliasTarget, 'alias file current\n');
      await fs.writeFile(empty, 'empty file now has content\n');
      await fs.writeFile(added, 'new path now has content\n');
      commit();
      const finished = git('rev-parse', 'HEAD^{tree}');

      const sessionId = randomUUID();
      const title = 'Smoke baseline checkpoint history';
      const recordFile = path.join(homeDir(), '.squadron', 'transcripts', `${sessionId}.jsonl`);
      const at = Date.now() - 60_000;
      const cases = [
        { label: 'First checkpoint', file: shared, tree: first },
        { label: 'Second checkpoint', file: shared, tree: second },
        { label: 'Alias checkpoint', file: aliased, tree: first },
        { label: 'Empty checkpoint', file: empty, tree: first },
        { label: 'New path checkpoint', file: added, tree: first },
        { label: 'Unavailable checkpoint', file: unavailable, tree: '0'.repeat(40) },
        { label: 'Malformed checkpoint', file: malformed, tree: '--not-a-tree' }
      ];
      // Raw ck notes exercise recovery and attribution; no resolved base enters the fixture.
      const lines: unknown[] = [
        { v: SCHEMA, sessionId, cwd: path.join(homeDir(), 'project'), brand: 'claude' }
      ];
      for (const [i, item] of cases.entries()) {
        const ck: TurnCheckpoint = {
          tree: repo,
          from: { tree: item.tree, head, at: at + i * 1000 },
          to: { tree: finished, head, at: at + i * 1000 + 500 },
          changes: { files: [item.file], sizes: { [item.file]: { add: 1, del: 1 } } }
        };
        lines.push(
          {
            role: 'user',
            text: i === 0 ? title : item.label,
            blocks: [{ text: i === 0 ? title : item.label }],
            at: ck.from.at
          },
          {
            role: 'assistant',
            text: item.label,
            blocks: [{ text: item.label }],
            at: ck.to.at,
            files: [item.file],
            sizes: ck.changes.sizes
          },
          { ck }
        );
      }
      await fs.mkdir(path.dirname(recordFile), { recursive: true });
      await fs.writeFile(recordFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
      const beforePids = await pids();
      await panel().locator('[data-act="resume"]').first().click();
      await panel().locator('#picker .pit', { hasText: title }).click();
      const pid = await waitForNewPid(beforePids);
      const panes = (tab: Locator) => {
        const group = tab.locator(
          'xpath=ancestor::div[contains(@class, "editor-group-container")][1]'
        );
        return {
          original: group.locator(
            '.monaco-diff-editor:visible .original-in-monaco-diff-editor > .overflow-guard > .monaco-scrollable-element > .lines-content > .view-lines'
          ),
          modified: group.locator(
            '.monaco-diff-editor:visible .modified-in-monaco-diff-editor > .overflow-guard > .monaco-scrollable-element > .lines-content > .view-lines'
          )
        };
      };
      const tabs = (file: string, claim: string) =>
        ctx.page.locator('.tabs-container .tab', { hasText: `${path.basename(file)} — ${claim}` });
      const clickPill = async (label: string) => {
        await panel().locator(`#cards .card[data-pid="${pid}"]`).click();
        await panel()
          .locator('#thread .turn.assistant', { hasText: label })
          .locator('.wnum')
          .click();
      };
      const closeTab = async (tab: Locator) => {
        const count = await ctx.page.locator('.tabs-container .tab').count();
        await tab.click();
        await ctx.page.keyboard.press('ControlOrMeta+W');
        await ctx.page.waitForFunction(
          (before) => document.querySelectorAll('.tabs-container .tab').length < before,
          count,
          { timeout: 30_000 }
        );
      };
      t.after(async () => {
        const remaining = ctx.page.locator('.tabs-container .tab', {
          hasText: /two-turns|alias-target|empty-before|added-later|unavailable|malformed/
        });
        try {
          while ((await remaining.count()) > 0) await closeTab(remaining.first());
        } finally {
          await endCard(pid);
          await fs.rm(recordFile, { force: true });
          await fs.rm(alias, { force: true });
          await fs.rm(repo, { recursive: true, force: true });
        }
      });
      await clickPill('First checkpoint');
      const turnTabs = tabs(shared, 'since this turn');
      let { original, modified } = panes(turnTabs.first());
      await turnTabs.first().waitFor({ timeout: 30_000 });
      const firstTab = turnTabs.first();
      await firstTab.dblclick();
      await expectText(original, 'first baseline');
      await expectText(modified, 'committed after both turns');
      await clickPill('Second checkpoint');
      await turnTabs.nth(1).waitFor({ timeout: 30_000 });
      const secondTab = turnTabs.nth(1);
      await secondTab.dblclick();
      ({ original, modified } = panes(turnTabs.nth(1)));
      await expectText(original, 'second baseline');
      assert.equal(
        await turnTabs.count(),
        2,
        'two turns of one file must have distinct diff documents'
      );

      await clickPill('Alias checkpoint');
      const aliasTab = tabs(aliased, 'since this turn');
      await aliasTab.waitFor({ timeout: 30_000 });
      await aliasTab.click();
      ({ original, modified } = panes(aliasTab));
      await expectText(original, 'aliased baseline');
      await expectText(modified, 'alias file current');
      await closeTab(aliasTab);

      for (const [label, file, body] of [
        ['Empty checkpoint', empty, 'empty file now has content'],
        ['New path checkpoint', added, 'new path now has content']
      ] as const) {
        await clickPill(label);
        const tab = tabs(file, 'since this turn');
        await tab.waitFor({ timeout: 30_000 });
        await tab.click();
        ({ original, modified } = panes(tab));
        await expectText(modified, body);
        assert.equal(
          ((await original.textContent()) ?? '').trim(),
          '',
          `${label} must resolve empty, despite nonempty HEAD`
        );
        await closeTab(tab);
      }
      await clickPill('Malformed checkpoint');
      const malformedTab = tabs(malformed, 'since HEAD');
      await malformedTab.waitFor({ timeout: 30_000 });
      await malformedTab.click();
      ({ original, modified } = panes(malformedTab));
      await expectText(original, 'malformed at HEAD');
      await closeTab(malformedTab);

      await clickPill('Unavailable checkpoint');
      const fallbackTab = tabs(unavailable, 'since HEAD');
      await fallbackTab.waitFor({ timeout: 30_000 });
      await fallbackTab.click();
      ({ original, modified } = panes(fallbackTab));
      await expectText(original, 'fallback at HEAD');
      await fs.writeFile(unavailable, 'fallback after commit\n');
      await fs.writeFile(shared, 'live after later commit\n');
      commit();
      // A fallback refresh witnesses the HEAD watch cycle before checking immutable tabs.
      await expectText(original, 'fallback after commit', 30_000);
      await closeTab(fallbackTab);
      git('prune', '--expire=now');
      assert.throws(() => git('cat-file', '-e', second), 'the loose baseline must be gone');
      await secondTab.click();
      ({ original, modified } = panes(turnTabs.nth(1)));
      await modified.click();
      await ctx.page.keyboard.press(testPlatform() === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
      await expectText(original, 'second baseline');
      await expectText(modified, 'live after later commit');
      await firstTab.click();
      ({ original, modified } = panes(turnTabs.first()));
      await modified.click();
      await ctx.page.keyboard.press(testPlatform() === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
      await expectText(original, 'first baseline');
      await expectText(modified, 'live after later commit');
      while ((await turnTabs.count()) > 0) await closeTab(turnTabs.first());

      await fs.rm(shared);
      await clickPill('First checkpoint');
      const deletedTab = tabs(shared, 'since this turn started (deleted)');
      await deletedTab.waitFor({ timeout: 30_000 });
      await deletedTab.click();
      ({ original, modified } = panes(deletedTab));
      await expectText(original, 'first baseline');
      assert.equal(((await modified.textContent()) ?? '').trim(), '');
      assert.equal(await ctx.page.locator('.monaco-editor-overlaymessage').count(), 0);
      await closeTab(deletedTab);
    }
  );

  /**
   * The case a probe reading return values got wrong. `vscode.diff` against a
   * *missing* right-hand file resolves without throwing, and the tab then paints
   * "The editor could not be opened because the file was not found" over both
   * panes — a success by every instrument except the window.
   *
   * So the host stats the path first and diffs against an empty right side
   * instead, which is the true statement about a file a turn wrote and a later
   * turn removed: every line of it gone.
   */
  step('diffs against an empty side when the file a turn wrote has gone', async () => {
    const file = path.join(homeDir(), 'project', DIFFED);
    const body = await fs.readFile(file, 'utf8');
    await fs.rm(file);
    try {
      await openPanel();
      await fixtureSession();
      await panel().locator('.card', { hasText: FIXTURE_NAME }).click();

      // The pill is a reading of the transcript, so a turn still says it wrote
      // the file — which is exactly why the click has to survive the file going.
      const num = panel().locator('#thread .wpill .wnum').first();
      await num.waitFor({ timeout: 30_000 });
      await num.click();

      const tab = ctx.page.locator('.tabs-container .tab', {
        hasText: `${DIFFED} — at HEAD (deleted)`
      });
      await tab.waitFor({ timeout: 30_000 });

      // Drawn, rather than the host's error over both panes.
      await ctx.page
        .locator('.monaco-diff-editor .original-in-monaco-diff-editor')
        .waitFor({ timeout: 30_000 });
      assert.equal(await ctx.page.locator('.monaco-editor-overlaymessage').count(), 0);

      await ctx.page.keyboard.press('ControlOrMeta+W');
      await tab.waitFor({ state: 'detached', timeout: 30_000 });
      await openDraft();
    } finally {
      // Put back, so this is not a change every later step inherits.
      await fs.writeFile(file, body);
    }
  });
  step('opens a turn’s file links at their line and column', async () => {
    await openPanel();
    await fixtureSession();
    const project = path.join(homeDir(), 'project');
    const file = path.join(project, 'link target.md');
    await fs.writeFile(file, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
    const href = file.replaceAll(' ', '%20');
    await panel().locator('.card', { hasText: FIXTURE_NAME }).click();
    await composer().fill(
      `[line](${href}:88) [column](${href}:88:4) [fragment](${href}#L87C3) ` +
        `<a href="${pathToFileURL(file).href}#L86C2">uri</a> [relative](./link%20target.md:85:2)`
    );
    await composer().press('Enter');

    for (const [label, position] of [
      ['line', 'Ln 88, Col 1'],
      ['column', 'Ln 88, Col 4'],
      ['fragment', 'Ln 87, Col 3'],
      ['uri', 'Ln 86, Col 2'],
      ['relative', 'Ln 85, Col 2']
    ] as const) {
      const link = panel()
        .locator('#thread .turn.assistant .body a')
        .filter({ hasText: new RegExp(`^${label}$`) });
      await link.waitFor({ timeout: 30_000 });
      await link.click();
      const tab = ctx.page.locator('.tabs-container .tab', { hasText: 'link target.md' });
      await tab.waitFor({ timeout: 30_000 });
      await expectText(ctx.page.locator('[id="status.editor.selection"]'), position);
      assert.equal(await ctx.page.locator('.monaco-editor-overlaymessage').count(), 0);
      await ctx.page.keyboard.press('ControlOrMeta+W');
      await tab.waitFor({ state: 'detached', timeout: 30_000 });
    }
    await openDraft();
  });
});
