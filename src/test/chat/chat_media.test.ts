import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerFilePick,
  answerOpen,
  answerSend,
  assertedMessageBody,
  cardView,
  composerKey,
  composerPills,
  composerValue,
  enter,
  escape,
  groupView,
  importComposer,
  newDraft,
  openPanel,
  openThread,
  pasteComposer,
  selectComposer,
  stateMessage,
  typeIn,
  unreachableThread,
  threadView,
  Panel
} from '../harness';

describe('a pasted image', () => {
  /**
   * jsdom has no `ClipboardEvent` carrying a usable `clipboardData`, so the
   * event is built by hand — the same shape the handler reads, no more. The
   * handler decodes the blob asynchronously, which is why every scenario here
   * awaits, unlike the rest of the file.
   */
  const beginPaste = (p: Panel, files: { name: string; type: string }[]): void => {
    pasteComposer(p, { files });
  };

  const drainPaste = async (): Promise<void> => {
    // The handler decodes through `FileReader`, which jsdom settles over
    // several turns rather than on the microtask queue — hence a short drain
    // rather than a single `await`, and the awaits in every scenario here.
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };

  const paste = async (p: Panel, files: { name: string; type: string }[]) => {
    beginPaste(p, files);
    await drainPaste();
  };

  const pills = (p: Panel): HTMLElement[] => composerPills(p);

  /** Puts text in and leaves the caret at the end, without an `input` event: a paste reads the caret. */
  const type = (p: Panel, text: string): void => {
    importComposer(p, text);
    selectComposer(p, text.length);
  };

  /** Backspace at the caret. On a chip, that removes the chip. */
  const backspace = (p: Panel): void => {
    composerKey(p, 'Backspace', { cancelable: false });
  };

  it('is something to send on its own, so the button offers it', async (t) => {
    // An image alone is a message: the CLI takes a prompt that is nothing but
    // an attachment. The marker enables send; deleting it unattaches.
    const p = openThread(t, threadView());
    const send = p.window.document.getElementById('send') as HTMLButtonElement;
    assert.equal(send.disabled, true);
    await paste(p, [{ name: 'shot.png', type: 'image/png' }]);
    assert.equal(send.disabled, false, 'an attached image was not something to send');
    // Just after the chip, before the space set after it.
    selectComposer(p, '[Image #1]'.length);
    backspace(p);
    assert.equal(composerValue(p).trim(), '');
    assert.equal(send.disabled, true);
  });

  it('marks the caret the way the TUI does and paints an inline pill', async (t) => {
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'Screenshot.png', type: 'image/png' }]);
    assert.equal(composerValue(p), '[Image #1] ');
    assert.equal(pills(p).length, 1);
    assert.match(pills(p)[0]?.textContent ?? '', /\[Image #1\]/);
    assert.equal(p.posted.filter((m) => m.type === 'send').length, 0);
    assert.equal(p.window.document.getElementById('chips'), null, 'no chip strip');
  });

  it('marks where the caret was, not the end of the draft', async (t) => {
    const p = openThread(t, threadView());
    type(p, 'before after');
    selectComposer(p, 7);
    await paste(p, [{ name: 'shot.png', type: 'image/png' }]);
    assert.equal(composerValue(p), 'before [Image #1] after');
  });

  it('numbers the markers in the order the images are sent', async (t) => {
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'one.png', type: 'image/png' }]);
    await paste(p, [{ name: 'two.png', type: 'image/png' }]);
    assert.equal(composerValue(p), '[Image #1] [Image #2] ');
  });

  it('sends the image alongside the text', async (t) => {
    const p = openThread(t, threadView());
    type(p, 'why is this clipped? ');
    await paste(p, [{ name: 'Screenshot.png', type: 'image/png' }]);
    enter(p);

    const sent = p.posted.at(-1);
    assert.equal(sent?.type, 'send');
    assert.equal(sent.type === 'send' ? sent.text : '', 'why is this clipped? [Image #1]');
    const images = sent.type === 'send' ? (sent.images ?? []) : [];
    assert.equal(images.length, 1);
    assert.equal(images[0]?.name, 'Screenshot.png');
    assert.equal(images[0]?.mediaType, 'image/png');
    assert.match(images[0]?.dataUrl ?? '', /^data:image\/png;base64,/);
    assert.equal(composerValue(p), '', 'the box clears with the send');
  });

  it('sends an image with no prose of its own', async (t) => {
    // The marker is all the text there is, which is what the TUI sends too.
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'shot.png', type: 'image/png' }]);
    enter(p);
    const sent = p.posted.at(-1);
    assert.equal(sent?.type, 'send');
    assert.equal(sent.type === 'send' ? sent.text : 'x', '[Image #1]');
    assert.equal(sent.type === 'send' ? sent.images?.length : 0, 1);
  });

  it('backspaces the marker off, and then sends a plain message', async (t) => {
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'shot.png', type: 'image/png' }]);
    selectComposer(p, '[Image #1]'.length);
    backspace(p);
    assert.equal(composerValue(p).trim(), '', 'the marker goes with the image it stood for');
    type(p, 'never mind');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'never mind'
    });
  });

  it('renumbers the markers left when a middle image goes', async (t) => {
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'one.png', type: 'image/png' }]);
    await paste(p, [{ name: 'two.png', type: 'image/png' }]);
    await paste(p, [{ name: 'three.png', type: 'image/png' }]);
    // Drop the middle chip: one Backspace just after it.
    selectComposer(p, '[Image #1] [Image #2]'.length);
    backspace(p);
    enter(p);

    const sent = p.posted.at(-1);
    assert.equal(sent?.type, 'send');
    assert.match(sent.type === 'send' ? sent.text : '', /^\[Image #1\] +\[Image #2\]$/);
    const images = sent.type === 'send' ? (sent.images ?? []) : [];
    assert.deepEqual(
      images.map((image) => image.name),
      ['one.png', 'three.png'],
      'marker #2 has to stand for the image that is now second'
    );
  });

  it('relabels the chips left when an earlier image goes, and again on Undo', async (t) => {
    // The wire is numbered at capture; the box has to say the same number
    // the send will, before the send.
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'one.png', type: 'image/png' }]);
    await paste(p, [{ name: 'two.png', type: 'image/png' }]);
    selectComposer(p, '[Image #1]'.length);
    backspace(p);
    assert.deepEqual(
      pills(p).map((pill) => pill.textContent),
      ['[Image #1]']
    );
    assert.equal(composerValue(p).trim(), '[Image #1]');
    composerKey(p, 'z', { ctrlKey: true });
    assert.deepEqual(
      pills(p).map((pill) => pill.textContent),
      ['[Image #1]', '[Image #2]']
    );
    composerKey(p, 'z', { ctrlKey: true, shiftKey: true });
    assert.deepEqual(
      pills(p).map((pill) => pill.textContent),
      ['[Image #1]']
    );
  });

  it('leaves a number the reader typed about something else alone', async (t) => {
    const p = openThread(t, threadView());
    type(p, 'compare with [Image #7] in the spec ');
    await paste(p, [{ name: 'shot.png', type: 'image/png' }]);
    // Drop only the attached marker (#1); prose about #7 stays.
    typeIn(
      p,
      'compare with [Image #7] in the spec ',
      'compare with [Image #7] in the spec '.length
    );
    assert.equal(composerValue(p), 'compare with [Image #7] in the spec ');
  });

  it('refuses a type the CLI would not attach', async (t) => {
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'diagram.svg', type: 'image/svg+xml' }]);
    assert.equal(pills(p).length, 0);
    assert.equal(composerValue(p), '');
    assert.match(
      p.window.document.getElementById('blocked')?.textContent ?? '',
      /png|jpeg|gif|webp/i
    );
  });

  /** A draft answers to no card, so the thread still up from the last one does
   *  not gate it — the `mine` the paste handler reads says why. */
  it('takes a paste into a draft opened off a card that cannot attach', async (t) => {
    const p = openPanel(t);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 7 })] })], {
        thread: unreachableThread({ pid: 7 })
      })
    );
    p.window.document.querySelector<HTMLElement>('.card[data-pid="7"]')?.click();
    newDraft(p);
    await paste(p, [{ name: 'one.png', type: 'image/png' }]);
    assert.match(composerValue(p), /\[Image #1\]/, 'the draft dropped the paste');
    assert.equal(pills(p).length, 1);
  });

  it('keeps attaches per session, like drafts', async (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ sessions: [cardView({ pid: 1 }), cardView({ pid: 2 })] })]));
    p.window.document.querySelectorAll<HTMLElement>('.card')[0]?.click();
    await paste(p, [{ name: 'one.png', type: 'image/png' }]);
    assert.match(composerValue(p), /\[Image #1\]/);
    p.window.document.querySelectorAll<HTMLElement>('.card')[1]?.click();
    assert.equal(composerValue(p), '');
    p.window.document.querySelectorAll<HTMLElement>('.card')[0]?.click();
    assert.match(composerValue(p), /\[Image #1\]/);
  });

  it('drops a decoded image when its pid has been recycled', async (t) => {
    const p = openThread(t, threadView({ pid: 101, startedAt: 1_000 }));
    beginPaste(p, [{ name: 'old.png', type: 'image/png' }]);
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101, startedAt: 20_000 })] })], {
        thread: threadView({ pid: 101, startedAt: 20_000 })
      })
    );
    await drainPaste();
    assert.equal(composerValue(p), '');
    assert.equal(pills(p).length, 0);
  });

  /** A draft is another owner, so it starts without the session's chips. */
  it('leaves no pill over the draft that replaced the session', async (t) => {
    const p = openThread(t, threadView());
    await paste(p, [{ name: 'shot.png', type: 'image/png' }]);
    assert.equal(pills(p).length, 1, 'the session had no pill to leave');
    newDraft(p);
    assert.equal(composerValue(p), '', 'the draft did not start empty');
    assert.equal(pills(p).length, 0, 'the draft kept the pill of the session it replaced');
  });

  /** And the paint is all that goes. The image is the session's and is still
   *  attached to it: a fix that dropped the attachment would pass the scenario
   *  above by losing the reader's work. */
  it('gives the pill back with the session the draft replaced', async (t) => {
    const p = openThread(t, threadView({ pid: 101 }));
    await paste(p, [{ name: 'shot.png', type: 'image/png' }]);
    newDraft(p);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    assert.match(
      composerValue(p),
      /\[Image #1\]/,
      'the draft took the session\u2019s marker with it'
    );
    assert.equal(pills(p).length, 1, 'the marker came back without its pill');
  });
});

describe('a file picked from the composer', () => {
  const clip = (p: Panel): HTMLButtonElement =>
    p.window.document.getElementById('fattach') as HTMLButtonElement;
  const pills = (p: Panel): HTMLElement[] => composerPills(p);
  const backspace = (p: Panel): void => {
    composerKey(p, 'Backspace', { cancelable: false });
  };
  const pick = (p: Panel, paths: string[]): void => {
    clip(p).click();
    answerFilePick(p, paths);
  };

  /**
   * `canAttach` is about image *bytes*, and the clip sends none: a picked path
   * is the chip's delivery, so it reaches the CLI as text. A session that
   * cannot take an inline image can still be told to read a file, so the clip
   * is offered where the paste is not.
   */
  it('offers the clip to a thread that cannot take an image', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle', canAttach: false }));
    assert.equal(clip(p).disabled, false);
    pick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), '/tmp/a.ts ');
  });

  it('asks the host for its file dialog', (t) => {
    // The webview cannot name a file on this machine, so the clip only asks:
    // the picking is `showOpenDialog`'s, host-side. `cwd` is where it opens and
    // is the whole address — no pid, so a draft can post the same message.
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    clip(p).click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'pickFiles',
      cwd: '/Users/someone/proj'
    });
  });

  /**
   * A session that has moved groups under where it was *started*
   * (`core/live.ts`, `originCwd ?? cwd`), so the folder on the card is not the
   * one the dialog should open in. Without `liveCwd` the clip offers the repo
   * root to a session working in a worktree.
   */
  it('opens the dialog where the session stands, not where it started', (t) => {
    const p = openPanel(t);
    const groups = [
      groupView({
        sessions: [cardView({ pid: 101, liveCwd: '/Users/someone/proj/.worktrees/topic' })]
      })
    ];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, status: 'idle' }) }));
    clip(p).click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'pickFiles',
      cwd: '/Users/someone/proj/.worktrees/topic'
    });
  });

  it('inserts a short token at the caret and paints a pill', (t) => {
    // The chip's label is the basename. Its delivery, in the box and on the
    // wire, is the path.
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    importComposer(p, 'read this ');
    selectComposer(p, 'read this '.length);
    pick(p, ['/tmp/a.ts', '/tmp/b.ts']);
    assert.equal(composerValue(p), 'read this /tmp/a.ts /tmp/b.ts ');
    assert.equal(pills(p).length, 2);
    assert.equal(pills(p)[0]?.textContent, '@a.ts');
    assert.equal(pills(p)[1]?.textContent, '@b.ts');
    assert.equal(
      (p.window.document.getElementById('send') as HTMLButtonElement).disabled,
      false,
      'a path is something to send'
    );
    assert.equal(p.window.document.getElementById('chips'), null, 'no chip strip');
  });

  it('leaves a space before a pill when the caret sat after prose', (t) => {
    // Without the space the chip sits flush against the preceding word.
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    importComposer(p, 'see');
    selectComposer(p, 'see'.length);
    pick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), 'see /tmp/a.ts ');
    assert.equal(pills(p).length, 1);
  });

  it('is a message on its own when the box only holds tokens', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    pick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), '/tmp/a.ts ');
    assert.equal((p.window.document.getElementById('send') as HTMLButtonElement).disabled, false);
  });

  it('does not mint a second token for a path already attached', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    pick(p, ['/tmp/a.ts']);
    pick(p, ['/tmp/a.ts', '/tmp/b.ts']);
    // Same path still in the text — only @b.ts is new.
    assert.equal(composerValue(p), '/tmp/a.ts /tmp/b.ts ');
    assert.equal(pills(p).length, 2);
  });

  it('backspaces a token off and unattaches it', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    importComposer(p, 'read this ');
    selectComposer(p, 'read this '.length);
    pick(p, ['/tmp/a.ts', '/tmp/b.ts']);
    // Caret just after the last chip; one Backspace drops it.
    selectComposer(p, composerValue(p).trimEnd().length);
    backspace(p);
    assert.equal(composerValue(p).trimEnd(), 'read this /tmp/a.ts');
    assert.equal(pills(p).length, 1);
    assert.equal(pills(p)[0]?.textContent, '@a.ts');
  });

  it('leaves the box alone when the dialog picked nothing', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    importComposer(p, 'read this');
    pick(p, []);
    assert.equal(composerValue(p), 'read this');
    assert.equal(pills(p).length, 0);
  });

  it('expands tokens in place on the wire and clears the box', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    importComposer(p, 'read this ');
    selectComposer(p, 'read this '.length);
    pick(p, ['/tmp/a.ts']);
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'read this /tmp/a.ts'
    });
    assert.equal(composerValue(p), '');
  });

  it('sends a path alone when the box only held a token', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    pick(p, ['/tmp/a.ts']);
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: '/tmp/a.ts'
    });
  });

  it('hands typed tokens back when the send was refused', (t) => {
    // A refused send puts the draft back. The path is the delivery and the
    // pill is the basename, so a retry sends the path again.
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    importComposer(p, 'read this ');
    selectComposer(p, 'read this '.length);
    pick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), 'read this /tmp/a.ts ');
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'read this /tmp/a.ts'
    });
    answerSend(p, { ok: false, reason: 'session is gone' });
    assert.equal(composerValue(p), 'read this /tmp/a.ts ');
    assert.equal(pills(p).length, 1);
    assert.equal(pills(p)[0]?.textContent, '@a.ts');
    // The restored draft sends the same path.
    enter(p);
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), {
      type: 'send',
      pid: 101,
      text: 'read this /tmp/a.ts'
    });
  });

  it('ignores a file result that answers no operation', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    p.push({ type: 'pickedFiles', operationId: 'not-requested', paths: ['/tmp/a.ts'] });
    assert.equal(composerValue(p), '');
    assert.equal(pills(p).length, 0);
  });

  it('files a late dialog result with the session that opened it', (t) => {
    const p = openPanel(t);
    const groups = [
      groupView({
        sessions: [
          cardView({ pid: 101, startedAt: 1_000 }),
          cardView({ pid: 202, startedAt: 2_000 })
        ]
      })
    ];
    p.push(stateMessage(groups));
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 101, startedAt: 1_000, status: 'idle' })
      })
    );
    clip(p).click();

    p.window.document.querySelector<HTMLElement>('.card[data-pid="202"]')?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 202, startedAt: 2_000, status: 'idle' })
      })
    );
    answerFilePick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), '', 'the result repainted the active session');

    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    p.push(
      stateMessage(groups, {
        thread: threadView({ pid: 101, startedAt: 1_000, status: 'idle' })
      })
    );
    assert.equal(composerValue(p), '/tmp/a.ts ');
  });

  it('offers no clip for a session that cannot be sent to', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle', canSend: false }));
    assert.equal(clip(p).disabled, true);
    clip(p).click();
    assert.equal(
      p.posted.some((m) => m.type === 'pickFiles'),
      false,
      'a click that got through anyway is still refused'
    );
  });
});

describe('an image on a turn', () => {
  const withShot = (images: ImageRef[] = [{ id: 'p|/tmp/a.png', w: 2460, h: 1702 }]) =>
    threadView({
      exchanges: [{ role: 'user', text: 'look', blocks: [{ prose: 'look' }], images }]
    });
  // `.shotchip`, not `.chip`: the composer's attachment chip owns that name.
  const chip = (p: Panel) => p.window.document.querySelector<HTMLElement>('#thread .shotchip');
  const img = (p: Panel) => p.window.document.querySelector<HTMLImageElement>('#thread .shot img');
  const lightbox = (p: Panel) => p.window.document.getElementById('lightbox') as HTMLElement;
  const viewerImage = (p: Panel) =>
    lightbox(p).querySelector<HTMLImageElement>('img') as HTMLImageElement;
  const key = (p: Panel, value: string) =>
    lightbox(p).dispatchEvent(new p.window.KeyboardEvent('keydown', { key: value, bubbles: true }));
  const showThumbnail = (p: Panel): HTMLImageElement => {
    chip(p)?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', dataUrl: 'data:image/png;base64,AAAA' });
    const thumbnail = img(p);
    assert.ok(thumbnail, 'the host bytes drew no thumbnail');
    return thumbnail;
  };
  const openViewer = (p: Panel): HTMLImageElement => {
    const thumbnail = showThumbnail(p);
    thumbnail.click();
    assert.equal(lightbox(p).hidden, false, 'the thumbnail did not open the lightbox');
    return thumbnail;
  };

  describe('its lightbox', () => {
    it('opens from the thumbnail without posting to the host', (t) => {
      const p = openThread(t, withShot());
      const thumbnail = showThumbnail(p);
      const before = p.posted.length;
      thumbnail.click();
      assert.equal(lightbox(p).hidden, false);
      assert.equal(
        lightbox(p).querySelector('img')?.getAttribute('src'),
        'data:image/png;base64,AAAA'
      );
      assert.equal(p.posted.length, before, 'opening the in-panel viewer posted to the host');
    });

    it('closes from its close button and restores the thumbnail focus', (t) => {
      const p = openThread(t, withShot());
      const thumbnail = openViewer(p);
      lightbox(p).querySelector<HTMLElement>('.close')?.click();
      assert.equal(lightbox(p).hidden, true);
      assert.equal(p.window.document.activeElement, thumbnail);
    });

    it('releases the displayed image bytes when it closes', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      assert.equal(viewerImage(p).getAttribute('src'), 'data:image/png;base64,AAAA');
      lightbox(p).querySelector<HTMLElement>('.close')?.click();
      assert.equal(viewerImage(p).getAttribute('src'), null);
    });

    /**
     * Never #lscrim. The frame is inset: 0 over it, so the backdrop a reader
     * sees is painted by one element and hit-tested on another — a scenario
     * clicking #lscrim passes under jsdom, which has no hit-testing, while the
     * only live way out is the close button. The region is the frame itself.
     */
    it('closes from the region around the image', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      lightbox(p).click();
      assert.equal(lightbox(p).hidden, true);
    });

    it('stays open when the click lands on the image or its box', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      viewerImage(p).click();
      assert.equal(lightbox(p).hidden, false, 'clicking the image closed it');
      lightbox(p).querySelector<HTMLElement>('.lmodal')?.click();
      assert.equal(lightbox(p).hidden, false, 'clicking the modal box closed it');
    });

    it('does not close on the click that ends a pan', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      key(p, '+');
      const box = lightbox(p);
      const at = (type: string, clientX: number) =>
        box.dispatchEvent(
          new p.window.MouseEvent(type, { clientX, clientY: 10, button: 0, bubbles: true })
        );
      // jsdom has no PointerEvent, and the handlers read only these fields.
      at('pointerdown', 40);
      at('pointermove', 90);
      at('pointerup', 90);
      // Pointer capture sends the click to the frame, exactly as a live drag
      // that left the image would.
      box.click();
      assert.equal(box.hidden, false, 'a pan that ended outside the image closed it');
    });

    it('takes the composer Escape without interrupting the session', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      const before = p.posted.length;
      escape(p);
      assert.equal(lightbox(p).hidden, true);
      assert.equal(p.posted.length, before, 'Escape interrupted the session as well as closing');
    });

    it('leaves the composer its zoom and pan keys', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      key(p, '+');
      for (const value of ['+', '=', '-', '0', 'ArrowLeft']) {
        const press = composerKey(p, value);
        assert.equal(press.defaultPrevented, false, `the lightbox swallowed ${value} in the box`);
      }
      assert.match(viewerImage(p).style.transform, /scale\(1\.5\)$/);
    });

    it('steps, clamps and resets the transform from the keyboard', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      const image = viewerImage(p);

      key(p, '+');
      assert.equal(image.style.transform, 'translate(0px, 0px) scale(1.5)');
      for (let i = 0; i < 10; i++) key(p, '+');
      assert.match(image.style.transform, /scale\(4\)$/);
      for (let i = 0; i < 10; i++) key(p, '-');
      assert.equal(image.style.transform, '');

      key(p, '+');
      key(p, 'ArrowRight');
      assert.notEqual(image.style.transform, 'translate(0px, 0px) scale(1.5)');
      key(p, '0');
      assert.equal(image.style.transform, '');
    });

    it('zooms the wheel around the pointer', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      const image = viewerImage(p);
      lightbox(p).dispatchEvent(
        new p.window.WheelEvent('wheel', {
          deltaY: -250,
          clientX: 40,
          clientY: 60,
          bubbles: true,
          cancelable: true
        })
      );
      assert.equal(image.style.transform, 'translate(-20px, -30px) scale(1.5)');
    });

    it('pans with arrows only while zoomed', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      const image = viewerImage(p);
      key(p, 'ArrowRight');
      assert.equal(image.style.transform, '');
      key(p, '+');
      key(p, 'ArrowRight');
      assert.equal(image.style.transform, 'translate(-40px, 0px) scale(1.5)');
    });

    it('closes on Escape without resetting zoom first', (t) => {
      const p = openThread(t, withShot());
      openViewer(p);
      key(p, '+');
      assert.match(viewerImage(p).style.transform, /scale\(1\.5\)$/);
      key(p, 'Escape');
      assert.equal(lightbox(p).hidden, true);
    });
  });

  it('draws a chip, collapsed, carrying the size the CLI recorded', (t) => {
    const p = openThread(t, withShot());
    assert.match(chip(p)?.textContent ?? '', /2460 × 1702/);
    assert.equal(img(p), null);
  });

  it('says only "image" when nothing recorded a size', (t) => {
    const p = openThread(t, withShot([{ id: 't|u-1|1' }]));
    assert.equal(chip(p)?.textContent?.trim(), 'image');
  });

  it('asks the host for the bytes when opened, and says it is loading', (t) => {
    const p = openThread(t, withShot());
    chip(p)?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'image', pid: 101, id: 'p|/tmp/a.png' });
    assert.match(chip(p)?.textContent ?? '', /loading/);
  });

  it('shows the image once the bytes arrive', (t) => {
    const p = openThread(t, withShot());
    chip(p)?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', dataUrl: 'data:image/png;base64,AAAA' });
    assert.equal(img(p)?.getAttribute('src'), 'data:image/png;base64,AAAA');
  });

  it('leaves an opened image standing across a repaint, and asks for nothing more', (t) => {
    const p = openThread(t, withShot());
    chip(p)?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', dataUrl: 'data:image/png;base64,AAAA' });
    const before = p.posted.length;
    // The poll the dock lives under: the same thread, again, unchanged.
    p.push(
      stateMessage([groupView({ sessions: [cardView({ pid: 101 })] })], { thread: withShot() })
    );
    assert.equal(img(p)?.getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(p.posted.length, before);
  });

  it('asks only once however often it is reopened', (t) => {
    const p = openThread(t, withShot());
    chip(p)?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', dataUrl: 'data:image/png;base64,AAAA' });
    const before = p.posted.length;
    chip(p)?.click();
    assert.equal(p.posted.length, before);
  });

  it('explains a file that is gone, and stops being a control', (t) => {
    const p = openThread(t, withShot());
    chip(p)?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', reason: 'gone' });
    assert.match(chip(p)?.textContent ?? '', /not on disk/);
    assert.equal(img(p), null);
    const before = p.posted.length;
    chip(p)?.click();
    assert.equal(p.posted.length, before);
  });

  it('offers the editor for an image too large to inline', (t) => {
    const p = openThread(t, withShot());
    chip(p)?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', reason: 'tooLarge' });
    assert.match(chip(p)?.textContent ?? '', /too large/);
    assert.equal(img(p), null);
    p.window.document.querySelector<HTMLElement>('#thread .full')?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openImage', pid: 101, id: 'p|/tmp/a.png' });
    assert.equal(lightbox(p).hidden, true, 'a ref with no bytes opened the lightbox');
  });

  it('offers the editor beside an image it did show', (t) => {
    const p = openThread(t, withShot());
    chip(p)?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', dataUrl: 'data:image/png;base64,AAAA' });
    const editor = p.window.document.querySelector<HTMLElement>('#thread .full');
    assert.equal(editor?.textContent, 'open in editor');
    editor?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'openImage', pid: 101, id: 'p|/tmp/a.png' });
  });

  it('draws one on a turn Claude wrote, which is where a rendered file lands', (t) => {
    // Every other scenario here builds a `user` turn, because every image used
    // to arrive on one. A file a turn pointed at in its prose arrives on an
    // `assistant` turn instead, down the same path — so the role is the one
    // thing untested, and the one thing this feature changed.
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'assistant',
            text: 'rendered:',
            blocks: [{ html: '<p>rendered:</p>' }],
            images: [{ id: 'f|u-9|0.0|/tmp/shot.png' }]
          }
        ]
      })
    );
    assert.equal(chip(p)?.textContent?.trim(), 'image');
    chip(p)?.click();
    assert.deepEqual(p.posted.at(-1), { type: 'image', pid: 101, id: 'f|u-9|0.0|/tmp/shot.png' });
    p.push({
      type: 'imageData',
      id: 'f|u-9|0.0|/tmp/shot.png',
      dataUrl: 'data:image/png;base64,BBBB'
    });
    assert.equal(img(p)?.getAttribute('src'), 'data:image/png;base64,BBBB');
  });

  it('leaves a turn with no images without a chip at all', (t) => {
    const p = openThread(
      t,
      threadView({ exchanges: [{ role: 'user', text: 'hi', blocks: [{ prose: 'hi' }] }] })
    );
    assert.equal(p.window.document.querySelector('#thread .shots'), null);
  });
});

/**
 * The clip on an unsent New.
 *
 * A draft has no pid, and the pick used to be addressed by one — which is the
 * whole of why this control was drawn greyed with no way to learn why. The
 * message carries the box's folder instead, and the answer comes home on the
 * operation id, so nothing on this path forks on which kind of box asked.
 */
describe('a file picked into a draft', () => {
  const CWD = '/Users/someone/proj';
  const clip = (p: Panel): HTMLButtonElement =>
    p.window.document.getElementById('fattach') as HTMLButtonElement;

  it('offers the clip, and asks for the draft’s own folder', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ cwd: CWD, sessions: [] })]));
    newDraft(p, CWD);
    assert.equal(clip(p).disabled, false, 'the clip was greyed on a draft');
    clip(p).click();
    assert.deepEqual(assertedMessageBody(p.posted.at(-1)), { type: 'pickFiles', cwd: CWD });
  });

  it('writes the token into the draft and rides the promotion onto the card', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ cwd: CWD, sessions: [] })]));
    newDraft(p, CWD);
    typeIn(p, 'read this ');
    selectComposer(p, composerValue(p).length);
    clip(p).click();
    answerFilePick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), 'read this /tmp/a.ts ');

    enter(p);
    answerOpen(p, 9);
    // The draft's chip goes out as its path, the same delivery a session sends.
    const sent = p.posted.filter((m) => m.type === 'send').at(-1);
    assert.equal(sent?.pid, 9);
    assert.equal(sent?.text, 'read this /tmp/a.ts');
  });

  /**
   * The dialog is modal to the host, so the reader can open a New while it
   * stands — which is exactly the move the old wire could not survive, since
   * the answer named a pid and the box that asked was a draft or the other way
   * round. The paths belong to whoever asked.
   */
  it('lands on the session that asked, not on the New opened over it', (t) => {
    const p = openThread(t, threadView({ pid: 101, status: 'idle' }));
    clip(p).click();
    newDraft(p, CWD);
    answerFilePick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), '', 'the draft took a pick it never asked for');

    // Back to the card that did ask: its box kept the token.
    p.window.document.querySelector<HTMLElement>('.card')?.click();
    assert.match(composerValue(p), /\/tmp\/a\.ts/);
  });

  /**
   * The mirror of the case above, and the one the draft's own life nearly lost:
   * a reader presses New, reaches straight for the clip — an empty box is
   * exactly when a file is most likely to be the message — and clicks a card
   * while the dialog stands. Leaving an *empty* draft normally drops it, and a
   * dropped draft is a pick with nowhere to land.
   */
  it('keeps an empty draft alive while its own dialog is still standing', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ cwd: CWD, sessions: [cardView({ pid: 101 })] })]));
    newDraft(p, CWD);
    clip(p).click();
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    answerFilePick(p, ['/tmp/a.ts']);

    // Back to the New: the pick it asked for is in it.
    newDraft(p, CWD);
    assert.match(
      composerValue(p),
      /\/tmp\/a\.ts/,
      'the draft was dropped with its dialog still up'
    );
  });

  /**
   * And it must not be kept forever. A cancel answers with nothing rather than
   * not answering, so the id is released and the record becomes droppable —
   * otherwise that folder's New slot draws itself mid-draft for the rest of the
   * session over a box with nothing in it.
   */
  it('lets an empty draft go once its dialog is cancelled', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView({ cwd: CWD, sessions: [cardView({ pid: 101 })] })]));
    newDraft(p, CWD);
    clip(p).click();
    answerFilePick(p, []);
    p.window.document.querySelector<HTMLElement>('.card[data-pid="101"]')?.click();
    assert.equal(
      p.window.document.querySelector('.card.add.drafting'),
      null,
      'the folder went on drawing a draft nobody had typed in'
    );
  });

  /**
   * What `startedAt` used to guard, now free: the operation id was registered
   * on the record that asked, and a recycled pid gets a fresh one whose set
   * never held it.
   */
  it('drops a pick whose pid has been recycled under it', (t) => {
    const p = openThread(t, threadView({ pid: 101, startedAt: 1_000, status: 'idle' }));
    clip(p).click();
    const groups = [groupView({ sessions: [cardView({ pid: 101, startedAt: 90_000 })] })];
    p.push(stateMessage(groups, { thread: threadView({ pid: 101, startedAt: 90_000 }) }));
    answerFilePick(p, ['/tmp/a.ts']);
    assert.equal(composerValue(p), '', 'the new session took the old one’s pick');
  });
});
