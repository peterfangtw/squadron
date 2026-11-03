import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before } from 'node:test';
import type { Locator } from 'playwright-core';
import type { ProseHook } from '../../webview/prose';
import { homeDir, openPanel, panel, section, step } from './boot';
import {
  clearComposer,
  commitComposition,
  compose,
  composer,
  composerPills,
  composerShown,
  composerValue,
  dockReady,
  openDraft,
  pids,
  publishedSessionId,
  sendDraft,
  waitForNewPid
} from './kit';

/**
 * Native composer editing on a real host. This section starts its own child,
 * so its file is not the shared session in `session.smoke.ts`.
 */

/** One pixel, the image a paste in the composer section carries. */
const DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A session reference as a card's copy writes one: complete at its `]`. */
const REF = '@squadron[1][/t/a.jsonl]';

/**
 * A paste built inside the page: a fresh `DataTransfer` on a synthetic
 * `ClipboardEvent`. The system clipboard is never read or written.
 */
async function pasteInto(
  root: Locator,
  data: Record<string, string>,
  image = false
): Promise<void> {
  await root.evaluate(
    (el, { data, image, dot }) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
      if (image) {
        const bytes = Uint8Array.from(atob(dot), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
      }
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      );
    },
    { data, image, dot: DOT }
  );
}

/** A `copy` on the editing root into a fresh `DataTransfer`, read back. */
async function copyFrom(root: Locator): Promise<{ text: string; html: string }> {
  return root.evaluate((el) => {
    const transfer = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true })
    );
    return { text: transfer.getData('text/plain'), html: transfer.getData('text/html') };
  });
}

type HeldChip = { kind: string; expansion: string; attachmentId: string | null };

/** The composer's chips as its snapshot holds them, attachment ids included. */
async function chipsHeld(): Promise<HeldChip[]> {
  return composer().evaluate((root) => {
    type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[] };
    const host = root.closest('.prose') as unknown as { prose: { snapshot(): Node } };
    const out: { kind: string; expansion: string; attachmentId: string | null }[] = [];
    const walk = (node: Node): void => {
      if (node.type === 'chip') {
        out.push({
          kind: String(node.attrs?.kind),
          expansion: String(node.attrs?.expansion),
          attachmentId: (node.attrs?.attachmentId as string | null) ?? null
        });
      }
      node.content?.forEach(walk);
    };
    walk(host.prose.snapshot());
    return out;
  });
}

/**
 * Where the composer's selection is: its caret, or `chip` when the one chip
 * is selected as a node. `range` for any other selection.
 */
async function composerSpot(): Promise<string> {
  return composer().evaluate((root) => {
    const host = root.closest('.prose') as unknown as {
      prose: { selection: { caret(): number | null } };
    };
    const caret = host.prose.selection.caret();
    if (caret !== null) return String(caret);
    return root.querySelector('.pchip.ProseMirror-selectednode') ? 'chip' : 'range';
  });
}

/**
 * The composer's selection once the editor has read it as `want`. A native
 * arrow moves the DOM selection; the editor takes it on `selectionchange`.
 */
async function composerAt(want: string): Promise<void> {
  for (let look = 0; look < 50; look++) {
    if ((await composerSpot()) === want) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await composerSpot(), want);
}

/**
 * The words in the composer once the editor has read them. A native keystroke
 * reaches the document before the editor's state; a synthetic paste right
 * after it would land on the state before the keystroke.
 */
async function composerReads(text: string): Promise<void> {
  for (let look = 0; look < 50; look++) {
    if ((await composerValue()) === text) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await composerValue(), text);
}

/** The user turns this session's own record holds, once one reads `want`. */
async function recordedTurn(pid: string, want: string): Promise<Record<string, unknown>> {
  const id = await publishedSessionId(pid);
  const record = path.join(homeDir(), '.squadron', 'transcripts', `${id}.jsonl`);
  for (let look = 0; look < 120; look++) {
    const lines = await fs
      .readFile(record, 'utf8')
      .then((raw) =>
        raw
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      )
      .catch(() => [] as Record<string, unknown>[]);
    const turn = lines.find((line) => line.role === 'user' && line.text === want);
    if (turn) return turn;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`the record never held a user turn reading ${JSON.stringify(want)}`);
}

/**
 * The composer as the prose editor, in a real host: native typing, a paste
 * the page dispatches, the native arrows, the host's ⌘Z and an IME. jsdom
 * holds every rule about what each of these does to the document
 * (`prose.test.ts`, `chat_composer.test.ts`); this holds what only Chromium
 * and VS Code's webview frame decide — input rules off real keys, the caret
 * stepping a `contenteditable="false"` span, the frame's own handling of ⌘Z
 * and ⌘A, a composition. A child of its own, so a red here skips nothing in
 * the owned session's life in `session.smoke.ts`. Nothing sent carries a word `fake-cli.ts`
 * scripts a turn on.
 */
section('the composer is one editor, in the real IDE', () => {
  let owned = '';
  const idle = (): Promise<void> =>
    panel()
      .locator(`#cards .card[data-pid="${owned}"]`)
      .and(panel().locator('.idle'))
      .waitFor({ timeout: 30_000 });

  before(async () => {
    await openPanel();
    const was = await pids();
    await openDraft();
    await sendDraft('prose smoke opens');
    owned = await waitForNewPid(was);
    await idle();
    await dockReady();
  });

  step('shows typed **bold** as bold, and sends the stars', async () => {
    const box = composer();
    await clearComposer();
    await box.pressSequentially('**bold** move');
    await composerReads('**bold** move');
    await box.locator('strong', { hasText: 'bold' }).waitFor({ timeout: 10_000 });
    assert.equal(await composerShown(), 'bold move', 'the markers are drawn, not hidden');
    await box.press('Enter');
    await recordedTurn(owned, '**bold** move');
    // The settled turn is drawn from the same source, so it stays bold.
    await panel()
      .locator('#thread .turn.user .body strong', { hasText: 'bold' })
      .last()
      .waitFor({ timeout: 30_000 });
    await idle();
    // A send starts a fresh history: ⌘Z undoes nothing, the editor's or the
    // browser's. Held past the host's round trip, which is what it would take.
    await box.press('ControlOrMeta+z');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await composerValue(), '');
  });

  step('pastes an HTML list as a list, and plain text with its blank lines', async () => {
    const box = composer();
    await clearComposer();
    await pasteInto(box, {
      'text/html': '<ul><li><p>one</p></li><li><p>alpha</p></li></ul>',
      'text/plain': '- one\n- alpha'
    });
    await box.locator('ul li').nth(1).waitFor({ timeout: 10_000 });
    assert.equal(await composerValue(), '- one\n- alpha');

    await clearComposer();
    await pasteInto(box, { 'text/plain': 'a\n\n\nb  ' });
    assert.equal(await composerValue(), 'a\n\n\nb  ');
    assert.equal(await box.locator('ul').count(), 0);
  });

  step('forms a chip from a pasted session reference', async () => {
    const box = composer();
    await clearComposer();
    await pasteInto(box, { 'text/plain': `see ${REF} now` });
    await composerPills('session').first().waitFor({ timeout: 10_000 });
    assert.equal(await composerShown(), 'see @session 1 now');
    assert.equal(await composerValue(), `see ${REF} now`);
  });

  // ProseMirror's own arrow handling over a selectable atom: the first press
  // selects the chip, the second steps past it. The caret is never inside its
  // label, which a native caret in an uneditable span could otherwise reach.
  // Right after a clear, so it also holds ⌘A to the editor's own Select All:
  // the host's, arriving later, took `ab` here.
  step('steps the native arrows over a chip, never into its label', async () => {
    const box = composer();
    await clearComposer();
    await box.pressSequentially('ab');
    await composerReads('ab');
    await box.press('ArrowLeft');
    await composerAt('2');
    await pasteInto(box, { 'text/plain': REF });
    await composerPills('session').first().waitFor({ timeout: 10_000 });
    assert.equal(await composerValue(), `a${REF}b`);
    await composerAt('3');
    await box.press('ArrowLeft');
    await composerAt('chip');
    await box.press('ArrowLeft');
    await composerAt('2');
    await box.pressSequentially('X');
    await composerReads(`aX${REF}b`);
    await box.press('ArrowRight');
    await composerAt('chip');
    await box.press('ArrowRight');
    await composerAt('4');
    await box.pressSequentially('Y');
    await composerReads(`aX${REF}Yb`);
  });

  step('removes an image chip whole, and ⌘Z brings its image back', async () => {
    const box = composer();
    await clearComposer();
    await box.pressSequentially('look ');
    await composerReads('look ');
    await pasteInto(box, {}, true);
    await composerPills('image').first().waitFor({ timeout: 10_000 });
    const [pasted] = await chipsHeld();
    assert.equal(pasted?.kind, 'image');
    assert.ok(pasted?.attachmentId, 'the pasted image names no attachment');
    // A chip is padded with the space after it; the caret sits after that.
    assert.equal(await composerValue(), 'look [Image #1] ');
    await box.press('Backspace');
    await composerReads('look [Image #1]');
    assert.deepEqual(await chipsHeld(), [pasted]);

    await box.press('Backspace');
    await composerPills('image').first().waitFor({ state: 'detached', timeout: 10_000 });
    assert.deepEqual(await chipsHeld(), []);
    assert.equal(await composerValue(), 'look ');

    await box.press('ControlOrMeta+z');
    await composerPills('image').first().waitFor({ timeout: 10_000 });
    assert.deepEqual(await chipsHeld(), [pasted]);
    assert.equal(await composerValue(), 'look [Image #1]');

    // The image is still pooled under that id: the send carries its bytes.
    await box.press('Enter');
    const turn = await recordedTurn(owned, 'look [Image #1]');
    assert.equal((turn.images as unknown[] | undefined)?.length, 1, JSON.stringify(turn));
    await idle();
  });

  step('copies a chip as its expansion, and pastes it back as a chip', async () => {
    const box = composer();
    await clearComposer();
    await pasteInto(box, { 'text/plain': `see ${REF} now` });
    await composerPills('session').first().waitFor({ timeout: 10_000 });
    await box.press('ControlOrMeta+a');
    const copied = await copyFrom(box);
    assert.equal(copied.text, `see ${REF} now`);
    assert.ok(copied.html.includes(REF), `the HTML carries no expansion: ${copied.html}`);
    assert.ok(!copied.html.includes('@session 1'), 'the HTML carries the label');

    await clearComposer();
    await pasteInto(box, { 'text/plain': copied.text, 'text/html': copied.html });
    await composerPills('session').first().waitFor({ timeout: 10_000 });
    assert.equal(await composerValue(), `see ${REF} now`);
  });

  // Past ProseMirror's 500ms group between the typings, so each is an Undo
  // step. The redo is the host's half: before `shimKey` in `prose.ts` the
  // frame ran its own native redo after the editor's and sent `thirdd`.
  step('keeps its words and its Undo across a 3s poll, and redoes once', async () => {
    const box = composer();
    await clearComposer();
    await box.pressSequentially('first');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await box.pressSequentially(' second');
    await new Promise((resolve) => setTimeout(resolve, 800));
    await box.pressSequentially(' third');
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal(await composerValue(), 'first second third');
    assert.equal(
      await box.evaluate((root) => root.ownerDocument.activeElement === root),
      true,
      'the poll took the focus'
    );
    // Each held past the host's round trip (frame, workbench, `execCommand`),
    // which is the double this guards against.
    await box.press('ControlOrMeta+z');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await composerValue(), 'first second');
    await box.press('ControlOrMeta+Shift+z');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await composerValue(), 'first second third');
  });

  /**
   * The formatting toolbar (`TASK_done_composer_formatting.md`, Step 4).
   * jsdom holds what each control does to the document and the wire; this
   * holds what only a host decides — a real press keeping the selection it is
   * for, the frame's own ⌘Z after a conversion, focus coming back from a keyed
   * press, a tip over an `aria-disabled` control, and the controls' boxes.
   */
  const control = (format: string): Locator =>
    panel().locator(`#formatbar .format[data-format="${format}"]`);
  // alpha 1–6, beta 8–12, the empty one 14, gamma 16–21.
  const fourLines = (): Promise<void> =>
    panel()
      .locator('#input')
      .evaluate((host) => {
        const prose = (host as unknown as { prose: ProseHook }).prose;
        const text = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
        prose.restore(
          {
            type: 'doc',
            content: [text('alpha'), text('beta'), { type: 'paragraph' }, text('gamma')]
          },
          { history: 'fresh' }
        );
      });
  const selectIn = (from: number, to = from): Promise<void> =>
    panel()
      .locator('#input')
      .evaluate((host, [a, b]) => (host as unknown as { prose: ProseHook }).prose.select(a, b), [
        from,
        to
      ] as const);
  const focusInBox = (): Promise<boolean> =>
    composer().evaluate((root) => root.contains(root.ownerDocument.activeElement));

  step('formats a selection from a pressed control, and keeps it lit across a poll', async () => {
    const box = composer();
    await clearComposer();
    await box.click();
    await fourLines();
    await selectIn(1, 6);
    await control('bold').click();
    await box.locator('strong', { hasText: 'alpha' }).waitFor({ timeout: 10_000 });
    assert.equal(await focusInBox(), true, 'the press took the focus from the text');
    await selectIn(3);
    await panel().locator('#formatbar .format[data-format="bold"][aria-pressed="true"]').waitFor();
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    assert.equal(await control('bold').getAttribute('aria-pressed'), 'true', 'a poll unlit it');
    await box.press('ControlOrMeta+z');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await box.locator('strong').count(), 0, 'one ⌘Z did not take the bold back');
  });

  step('makes one code block of four lines, undoes it whole, and sends one fence', async () => {
    const box = composer();
    await clearComposer();
    await box.click();
    await fourLines();
    await selectIn(1, 21);
    await control('codeBlock').click();
    await box.locator('pre').waitFor({ timeout: 10_000 });
    assert.equal(await box.locator('pre').count(), 1);
    assert.equal(await box.locator('pre').textContent(), 'alpha\nbeta\n\ngamma');

    await box.press('ControlOrMeta+z');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await box.locator('pre').count(), 0, '⌘Z left a code block');
    assert.equal(await box.locator('p').count(), 4, '⌘Z did not bring the four lines back');
    await box.press('ControlOrMeta+Shift+z');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(await box.locator('pre').count(), 1, 'redo did not convert again');

    await box.press('Enter');
    const fence = '```\nalpha\nbeta\n\ngamma\n```';
    await recordedTurn(owned, fence);
    const turn = panel().locator('#thread .turn.user', { hasText: 'gamma' }).last();
    await turn.locator('pre').waitFor({ timeout: 30_000 });
    assert.equal(await turn.locator('pre').count(), 1, 'the settled turn split the block');
    await idle();
  });

  step('walks the toolbar by keyboard, and explains a refused code block', async () => {
    const box = composer();
    await clearComposer();
    await control('bold').focus();
    await control('bold').press('ArrowRight');
    assert.equal(
      await panel().locator('#formatbar .format:focus').getAttribute('data-format'),
      'italic'
    );
    await control('italic').press('Enter');
    assert.equal(await focusInBox(), true, 'a keyed press left focus on the toolbar');

    await box.click();
    await panel()
      .locator('#input')
      .evaluate((host) =>
        (host as unknown as { prose: ProseHook }).prose.insertChip('file', '/tmp/my_file.ts')
      );
    await selectIn(1);
    await panel()
      .locator('#formatbar .format[data-format="codeBlock"][aria-disabled="true"]')
      .waitFor({ timeout: 10_000 });
    await control('codeBlock').hover();
    await panel()
      .locator('.tip.phrase', { hasText: 'mention or attachment' })
      .waitFor({ timeout: 10_000 });
    await clearComposer();
  });

  step('lays its controls out at 28px above the text, at a narrow dock too', async () => {
    const dock = panel().locator('#dock');
    const held = await dock.evaluate((node) => (node as HTMLElement).style.width);
    const boxes = async () => {
      const controls = await panel().locator('#formatbar .format').all();
      return Promise.all(controls.map((c) => c.boundingBox()));
    };
    const check = async (width: string): Promise<void> => {
      const all = await boxes();
      const shell = await panel().locator('.shell').boundingBox();
      const input = await panel().locator('#input').boundingBox();
      assert.equal(all.length, 8);
      assert.ok(shell && input, `no shell or box at ${width}`);
      for (const b of all) {
        assert.ok(b, `a control has no box at ${width}`);
        assert.ok(
          Math.abs(b.width - 28) < 0.5 && Math.abs(b.height - 28) < 0.5,
          `${b.width}x${b.height} at ${width}`
        );
        assert.ok(
          b.x >= shell.x && b.x + b.width <= shell.x + shell.width + 0.5,
          `a control overhangs at ${width}`
        );
        assert.ok(b.y + b.height <= input.y + 0.5, `a control sits over the text at ${width}`);
      }
    };
    await check('the default dock');
    const rows = new Set((await boxes()).map((b) => Math.round(b?.y ?? 0)));
    const fits = await panel()
      .locator('#formatbar')
      .evaluate((node) => {
        const css = getComputedStyle(node);
        const groups = [...node.querySelectorAll('.formatgroup')];
        const required =
          groups.reduce((sum, group) => sum + group.getBoundingClientRect().width, 0) +
          parseFloat(css.columnGap) * (groups.length - 1);
        return node.getBoundingClientRect().width >= required;
      });
    assert.equal(rows.size === 1, fits, 'toolbar wrapping disagrees with its available width');
    await dock.evaluate((node) => {
      (node as HTMLElement).style.width = '320px';
    });
    try {
      await check('320px');
      assert.equal(
        new Set((await boxes()).map((b) => Math.round(b?.y ?? 0))).size,
        1,
        'the controls wrapped at 320px'
      );
    } finally {
      await dock.evaluate((node, was) => {
        (node as HTMLElement).style.width = was;
      }, held);
    }
  });

  // jsdom does not lay the box out. One line at rest, and a long draft scrolls
  // inside the ten-line cap.
  step('rests at one line and scrolls a long draft inside ten', async () => {
    await clearComposer();
    const empty = await panel()
      .locator('#input')
      .evaluate((host) => {
        const prose = host.querySelector('.ProseMirror');
        if (!prose) throw new Error('missing .ProseMirror');
        const style = getComputedStyle(prose);
        const lh = parseFloat(style.lineHeight);
        const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
        return { height: prose.getBoundingClientRect().height, line: lh + pad };
      });
    assert.ok(
      Math.abs(empty.height - empty.line) <= 1,
      `empty box is ${empty.height}px, one line is ${empty.line}px`
    );
    await panel()
      .locator('#input')
      .evaluate((host) => {
        const prose = (host as unknown as { prose: ProseHook }).prose;
        const text = (t: string) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
        prose.restore(
          { type: 'doc', content: Array.from({ length: 20 }, (_, i) => text(`line ${i + 1}`)) },
          { history: 'fresh' }
        );
      });
    const capped = await panel()
      .locator('#input')
      .evaluate((host) => {
        const lh = parseFloat(getComputedStyle(host).lineHeight);
        return { scroll: host.scrollHeight, client: host.clientHeight, cap: lh * 10 + 2 };
      });
    assert.ok(
      capped.scroll > capped.client,
      `a 20-line draft does not scroll (${capped.scroll} <= ${capped.client})`
    );
    assert.ok(
      capped.client <= capped.cap,
      `the box is ${capped.client}px, past ten lines (${capped.cap}px)`
    );
    await clearComposer();
  });

  step(
    'keeps Start, Send and Queue inside the composer and workflows reachable when narrow',
    async () => {
      const dock = panel().locator('#dock');
      const held = await dock.evaluate((node) => (node as HTMLElement).style.width);
      const workflow = panel().locator('#wattach .fpill');
      await workflow.waitFor();
      await clearComposer();
      await pasteInto(composer(), { 'text/plain': REF });
      await composerPills('session').waitFor({ timeout: 10_000 });
      try {
        for (const width of [200, 240, 279, 280, 300, 359, 360, 460]) {
          await dock.evaluate((node, width) => {
            (node as HTMLElement).style.width = `${width}px`;
          }, width);
          const geometry = await panel()
            .locator('#composer')
            .evaluate((node) => {
              const rect = (selector: string): DOMRect => {
                const found = node.querySelector(selector);
                if (!found) throw new Error(`missing ${selector}`);
                return found.getBoundingClientRect();
              };
              const shell = rect('.shell');
              const tools = rect('#ctools');
              const send = node.querySelector<HTMLButtonElement>('#send');
              const model = node.querySelector<HTMLElement>('#ctools .model .nm');
              const chip = node.querySelector<HTMLElement>('#input .pchip');
              if (!send || !model || !chip) throw new Error('missing send, model or mention');
              const oldLabel = send.getAttribute('aria-label');
              const oldModel = model.textContent;
              const oldChip = chip.textContent;
              model.textContent = 'A very long model name that cannot fit';
              chip.textContent = '@Comment cut: three batches ' + 'long-session-name'.repeat(12);
              try {
                const actions = ['Start', 'Send', 'Queue', 'Starting…'].map((label) => {
                  send.setAttribute('aria-label', label);
                  const box = send.getBoundingClientRect();
                  return {
                    label,
                    contained: box.left >= shell.left + 4 && box.right <= shell.right - 4,
                    square: Math.abs(box.width - 28) < 0.5 && Math.abs(box.height - 28) < 0.5,
                    stacked: box.top >= tools.bottom
                  };
                });
                const formats = [...node.querySelectorAll('#formatbar .format')];
                const groups = [...node.querySelectorAll('#formatbar .formatgroup')];
                const picker = rect('#wattach .fpill');
                const mention = chip.getBoundingClientRect();
                const input = rect('#input');
                return {
                  actions,
                  groups: groups.length,
                  groupsTogether: groups.every(
                    (group) =>
                      new Set(
                        [...group.children].map((control) => control.getBoundingClientRect().top)
                      ).size === 1
                  ),
                  controlsContained: formats.every((control) => {
                    const box = control.getBoundingClientRect();
                    return box.left >= shell.left && box.right <= shell.right;
                  }),
                  pickerContained: picker.left >= shell.left && picker.right <= shell.right,
                  mentionContained: mention.left >= input.left && mention.right <= input.right,
                  overflow:
                    node.querySelector('.shell')!.scrollWidth >
                    node.querySelector('.shell')!.clientWidth
                };
              } finally {
                if (oldLabel === null) send.removeAttribute('aria-label');
                else send.setAttribute('aria-label', oldLabel);
                model.textContent = oldModel;
                chip.textContent = oldChip;
              }
            });
          assert.equal(geometry.groups, 3, `formatting groups missing at ${width}px`);
          assert.ok(
            geometry.groupsTogether && geometry.controlsContained,
            `formatting overflows at ${width}px`
          );
          assert.ok(geometry.pickerContained, `workflow selector overflows at ${width}px`);
          assert.ok(geometry.mentionContained, `a long mention overflows at ${width}px`);
          assert.equal(geometry.overflow, false, `the composer scrolls sideways at ${width}px`);
          for (const action of geometry.actions) {
            assert.ok(action.square, `${action.label} is not 28px at ${width}px`);
            assert.ok(action.contained, `${action.label} overflows at ${width}px`);
            assert.equal(
              action.stacked,
              width < 280,
              `${action.label} uses the wrong row at ${width}px`
            );
          }
        }
        await dock.evaluate((node) => {
          (node as HTMLElement).style.width = '240px';
        });
        await workflow.click();
        await panel().locator('#wattach .fmenu').waitFor();
        const menu = await panel().locator('#wattach .fmenu').boundingBox();
        const body = await panel().locator('body').boundingBox();
        assert.ok(
          menu && body && menu.x >= body.x && menu.x + menu.width <= body.x + body.width,
          'the narrow workflow menu runs off the panel'
        );
        await workflow.click();
        await panel().locator('#wattach .fmenu').waitFor({ state: 'hidden' });
        const run = process.env['SQUADRON_RUN'];
        if (run)
          await panel()
            .locator('#composer')
            .screenshot({ path: path.join(run, 'composer-240.png') });
      } finally {
        await dock.evaluate((node, width) => {
          (node as HTMLElement).style.width = width;
        }, held);
        await clearComposer();
      }
    }
  );

  // Formation waits out a composition and runs at its end (`prose.ts`'s
  // `compositionend` listener), so a reference an IME completes forms there.
  step('composes through an IME in the composer, and forms a chip at its end', async () => {
    const box = composer();
    await clearComposer();
    await box.pressSequentially(REF.slice(0, -1));
    await composerReads(REF.slice(0, -1));
    assert.equal(await composerPills('session').count(), 0);
    await compose(']');
    await commitComposition(']');
    await composerPills('session').first().waitFor({ timeout: 10_000 });
    await composerReads(REF);

    await compose('ㄓㄨˋㄧㄣ');
    assert.match((await box.textContent()) ?? '', /ㄓㄨˋㄧㄣ$/);
    await commitComposition('注音');
    await composerReads(`${REF}注音`);
    assert.equal(await composerPills('session').count(), 1);
    await clearComposer();
  });
});
