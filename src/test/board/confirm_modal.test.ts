import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupView, openPanel, openThread, stateMessage, threadView } from '../harness';

const offer = (requestId = 'end-1'): ConfirmModalMessage => ({
  type: 'confirmModal',
  requestId,
  title: 'End Platform seam?',
  detail: '2 sessions below it are still running.\n\nTheir transcripts are kept.',
  actions: [
    { id: 'all', label: 'End all 3', destructive: true },
    { id: 'one', label: 'End just this one', destructive: true }
  ]
});

function button(p: ReturnType<typeof openPanel>, label: string): HTMLButtonElement {
  const found = [...p.window.document.querySelectorAll<HTMLButtonElement>('#cscrim button')].find(
    (b) => b.textContent === label
  );
  assert.ok(found, `missing ${label}`);
  return found;
}

describe('confirmation modal', () => {
  it('shows host copy as text, names the dialog, and focuses Cancel', (t) => {
    const p = openPanel(t);
    p.push({ ...offer(), detail: '<img src=x onerror=alert(1)>\nSecond paragraph' });
    const dialog = p.window.document.querySelector('#cscrim [role="dialog"]');
    assert.ok(dialog, 'confirmation did not open');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(
      p.window.document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent,
      offer().title
    );
    assert.equal(
      p.window.document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent,
      '<img src=x onerror=alert(1)>\nSecond paragraph'
    );
    assert.equal(dialog.querySelector('img'), null);
    assert.deepEqual(
      [...p.window.document.querySelectorAll('#cscrim .asfoot button')].map((b) => b.textContent),
      ['Cancel', 'End all 3', 'End just this one']
    );
    assert.equal(p.window.document.activeElement, button(p, 'Cancel'));
  });

  for (const action of offer().actions) {
    it(`returns only the offered ${action.id} action once`, (t) => {
      const p = openPanel(t);
      p.push(offer());
      const go = button(p, action.label);
      go.click();
      go.click();
      assert.deepEqual(p.posted, [
        { type: 'confirmModalResult', requestId: 'end-1', actionId: action.id }
      ]);
      assert.equal(p.window.document.querySelector<HTMLElement>('#cscrim')?.hidden, true);
    });
  }

  for (const way of ['Cancel', 'Escape', 'Close', 'backdrop']) {
    it(`cancels through ${way} and restores focus without ending a session`, (t) => {
      const p = openPanel(t);
      const opener = p.window.document.createElement('button');
      p.window.document.body.append(opener);
      opener.focus();
      p.push(offer());
      if (way === 'Escape') {
        p.window.document.dispatchEvent(
          new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      } else if (way === 'backdrop') {
        p.window.document.querySelector<HTMLElement>('#cscrim')?.click();
      } else if (way === 'Close') {
        p.window.document.querySelector<HTMLElement>('#cscrim [aria-label="Close"]')?.click();
      } else {
        button(p, way).click();
      }
      assert.deepEqual(p.posted, [{ type: 'confirmModalResult', requestId: 'end-1' }]);
      assert.equal(p.window.document.activeElement, opener);
    });
  }

  it('wraps Tab in both directions and survives unrelated state pushes', (t) => {
    const p = openPanel(t);
    p.push(stateMessage([groupView()]));
    p.push(offer());
    const last = button(p, 'End just this one');
    last.focus();
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    );
    const first = p.window.document.querySelector('#cscrim [aria-label="Close"]');
    assert.equal(p.window.document.activeElement, first);
    p.window.document.dispatchEvent(
      new p.window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    );
    assert.equal(p.window.document.activeElement, last);
    p.push(stateMessage([groupView()]));
    assert.equal(p.window.document.activeElement, last);
    last.click();
    assert.deepEqual(p.posted.at(-1), {
      type: 'confirmModalResult',
      requestId: 'end-1',
      actionId: 'one'
    });
  });

  it('Escape cancels confirmation before an image behind it', (t) => {
    const p = openThread(
      t,
      threadView({
        exchanges: [
          {
            role: 'user',
            text: 'look',
            blocks: [{ prose: 'look' }],
            images: [{ id: 'p|/tmp/a.png', w: 100, h: 100 }]
          }
        ]
      })
    );
    p.window.document.querySelector<HTMLElement>('#thread .shotchip')?.click();
    p.push({ type: 'imageData', id: 'p|/tmp/a.png', dataUrl: 'data:image/png;base64,AAAA' });
    p.window.document.querySelector<HTMLElement>('#thread .shot img')?.click();
    const image = p.window.document.querySelector<HTMLElement>('#lightbox');
    assert.ok(image && !image.hidden, 'the image did not open');
    p.push(offer());
    const before = p.posted.length;
    button(p, 'Cancel').dispatchEvent(
      new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    assert.deepEqual(p.posted.slice(before), [{ type: 'confirmModalResult', requestId: 'end-1' }]);
    assert.equal(image.hidden, false, 'Escape also closed the underlying image');
    assert.equal(p.window.document.querySelector<HTMLElement>('#cscrim')?.hidden, true);
  });

  it('cancels a replaced confirmation before answering the new one', (t) => {
    const p = openPanel(t);
    p.push(offer());
    p.push(offer('end-2'));
    button(p, 'End all 3').click();
    assert.deepEqual(p.posted, [
      { type: 'confirmModalResult', requestId: 'end-1' },
      { type: 'confirmModalResult', requestId: 'end-2', actionId: 'all' }
    ]);
  });
});
