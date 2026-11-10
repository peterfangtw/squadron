import * as assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { createStack, type Layer, type Stack } from '../../webview/layers';

/** A bare document with the composer's and the ask layer's ids, and a stack on it. */
function setup(t: TestContext): { doc: Document; win: Window & typeof globalThis; stack: Stack } {
  const dom = new JSDOM(
    '<!doctype html><body><div id="input"><div contenteditable="true" id="box"></div></div>' +
      '<div id="ask"><button id="answer">Answer</button></div><button id="away">Away</button></body>'
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  const stack = createStack(win);
  t.after(() => {
    stack.dispose();
    dom.window.close();
  });
  return { doc: win.document, win, stack };
}

function escape(win: Window & typeof globalThis, at: EventTarget, init: KeyboardEventInit = {}) {
  const e = new win.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init
  });
  at.dispatchEvent(e);
  return e;
}

function layer(kind: string, log: string[], over: Partial<Layer> = {}): Layer {
  return { kind, close: () => log.push(`close ${kind}`), escape: 'consume', ...over };
}

describe('layer stack', () => {
  it('offers Escape to the top layer first, one layer per press', (t) => {
    const { doc, win, stack } = setup(t);
    const log: string[] = [];
    const drawer = stack.push(layer('drawer', log));
    const menu = stack.push(layer('menu', log));

    const first = escape(win, doc.body);
    assert.deepEqual(log, ['close menu']);
    assert.equal(first.defaultPrevented, true);
    assert.equal(menu.open, false);
    assert.equal(drawer.open, true);

    escape(win, doc.body);
    assert.deepEqual(log, ['close menu', 'close drawer']);
    assert.equal(drawer.open, false);

    // Nothing open: the key is left for the fallbacks.
    assert.equal(escape(win, doc.body).defaultPrevented, false);
  });

  it('stops a taken key before any document listener hears it', (t) => {
    const { doc, win, stack } = setup(t);
    const heard: string[] = [];
    doc.addEventListener('keydown', () => heard.push('document'), true);
    stack.push(layer('sheet', []));
    escape(win, doc.body);
    assert.deepEqual(heard, []);
  });

  it('leaves an IME composition key to the IME', (t) => {
    const { doc, win, stack } = setup(t);
    const log: string[] = [];
    const sheet = stack.push(layer('sheet', log));
    const e = escape(win, doc.body, { isComposing: true });
    assert.deepEqual(log, []);
    assert.equal(e.defaultPrevented, false);
    assert.equal(sheet.open, true);
  });

  it('passes the key to the layer below when a layer passes or its handler declines', (t) => {
    const { doc, win, stack } = setup(t);
    const log: string[] = [];
    stack.push(layer('drawer', log));
    stack.push(layer('drag', log, { escape: 'pass' }));
    stack.push(
      layer('tip', log, {
        escape: () => {
          log.push('tip declined');
          return false;
        }
      })
    );
    escape(win, doc.body);
    assert.deepEqual(log, ['tip declined', 'close drawer']);
  });

  it('lets one handler take two presses before it closes', (t) => {
    const { doc, win, stack } = setup(t);
    const log: string[] = [];
    stack.push(layer('board', log));
    let flyout = true;
    const menus = stack.push(
      layer('menus', log, {
        escape: () => {
          if (flyout) {
            flyout = false;
            log.push('flyout shut');
          } else {
            log.push('menu shut');
            menus.pop();
          }
          return true;
        }
      })
    );
    escape(win, doc.body);
    assert.equal(menus.open, true);
    escape(win, doc.body);
    assert.equal(menus.open, false);
    escape(win, doc.body);
    assert.deepEqual(log, ['flyout shut', 'menu shut', 'close board']);
  });

  it('yields Escape to the composer and the ask layer only where a layer says so', (t) => {
    const { doc, win, stack } = setup(t);
    const log: string[] = [];
    stack.push(layer('sheet', log));
    stack.push(layer('drawer', log, { yieldsToComposer: true }));
    const box = doc.getElementById('box');
    const answer = doc.getElementById('answer');
    assert.ok(box && answer);

    // The drawer yields; the sheet under it does not, and takes the key.
    escape(win, box);
    assert.deepEqual(log, ['close sheet']);

    escape(win, answer);
    assert.deepEqual(log, ['close sheet']);
    const e = escape(win, answer);
    assert.equal(e.defaultPrevented, false, 'the interrupt fallback still hears it');

    escape(win, doc.body);
    assert.deepEqual(log, ['close sheet', 'close drawer']);
  });

  it('returns focus on pop to a connected target, and skips a disconnected one', (t) => {
    const { doc, stack } = setup(t);
    const away = doc.getElementById('away');
    const answer = doc.getElementById('answer');
    assert.ok(away && answer);

    away.focus();
    const sheet = stack.push(layer('sheet', [], { restoreFocus: away }));
    answer.focus();
    sheet.pop();
    assert.equal(doc.activeElement, away);

    const gone = doc.createElement('button');
    doc.body.append(gone);
    const menu = stack.push(layer('menu', [], { restoreFocus: () => gone }));
    gone.remove();
    answer.focus();
    menu.pop();
    assert.equal(doc.activeElement, answer);
  });

  it('takes no focus when a layer under the top pops', (t) => {
    const { doc, stack } = setup(t);
    const away = doc.getElementById('away');
    const answer = doc.getElementById('answer');
    assert.ok(away && answer);
    const drawer = stack.push(layer('drawer', [], { restoreFocus: away }));
    stack.push(layer('menu', []));
    answer.focus();
    drawer.pop();
    assert.equal(doc.activeElement, answer);
  });

  it('shuts the layers a new one excludes', (t) => {
    const { stack } = setup(t);
    const log: string[] = [];
    const login = stack.push(layer('sheet', log));
    const drawer = stack.push(layer('drawer', log));
    const mcp = stack.push(layer('sheet', log, { excludes: ['sheet'] }));
    assert.deepEqual(log, ['close sheet']);
    assert.equal(login.open, false);
    assert.equal(drawer.open, true);
    assert.equal(mcp.open, true);
  });

  it('keeps a ground layer beneath every surface open over it, whenever it opened', (t) => {
    const { doc, win, stack } = setup(t);
    const log: string[] = [];
    const sheetRoot = doc.createElement('div');
    const drawerRoot = doc.createElement('div');
    doc.body.append(sheetRoot, drawerRoot);
    const sheet = stack.push(layer('sheet', log, { root: () => [sheetRoot] }));
    const rail = stack.push(layer('rail', log, { ground: true }));
    const drawer = stack.push(layer('drawer', log, { ground: true, root: () => [drawerRoot] }));

    escape(win, doc.body);
    assert.deepEqual(log, ['close sheet'], 'a drawer opened later took the Escape over it');
    assert.equal(sheet.open, false);

    // Among themselves, push order: the later drawer is the upper one.
    escape(win, doc.body);
    assert.deepEqual(log, ['close sheet', 'close drawer']);
    assert.equal(rail.open, true);
    assert.equal(drawer.open, false);

    // A press reads the same order: the sheet is above a drawer pushed after it.
    const again = stack.push(layer('drawer', log, { ground: true, root: () => [drawerRoot] }));
    stack.push(layer('sheet', log, { root: () => [sheetRoot] }));
    const verdicts: boolean[] = [];
    doc.addEventListener('click', (e) => verdicts.push(stack.above(again, e)));
    sheetRoot.click();
    drawerRoot.click();
    assert.deepEqual(verdicts, [true, false]);
  });

  it('offers no layer an Escape that a field claims, while it claims it', (t) => {
    const { doc, win, stack } = setup(t);
    const log: string[] = [];
    stack.push(layer('drawer', log));
    const field = doc.createElement('input');
    doc.body.append(field);
    let reverting = true;
    stack.claim(field, () => reverting);
    const heard: boolean[] = [];
    field.addEventListener('keydown', (e) => heard.push(e.defaultPrevented));

    escape(win, field);
    assert.deepEqual(log, [], 'the layer took a key the field claimed');
    assert.deepEqual(heard, [false], 'the field did not hear its own Escape');

    reverting = false;
    escape(win, field);
    assert.deepEqual(log, ['close drawer']);
  });

  it('attributes a press to the layer it landed in, even when that layer pops during dispatch', (t) => {
    const { doc, stack } = setup(t);
    const drawerRoot = doc.createElement('div');
    const lightboxRoot = doc.createElement('div');
    const image = doc.createElement('img');
    lightboxRoot.append(image);
    doc.body.append(drawerRoot, lightboxRoot);

    const drawer = stack.push(layer('drawer', [], { root: () => [drawerRoot] }));
    const lightbox = stack.push(layer('lightbox', [], { root: () => [lightboxRoot] }));
    // A wire drag in flight: no root, never claims a press.
    stack.push(layer('drag', [], { escape: 'pass' }));
    image.addEventListener('click', () => lightbox.pop());

    const verdicts: Array<[string, boolean]> = [];
    doc.addEventListener('click', (e) => {
      verdicts.push([(e.target as Element).tagName, stack.above(drawer, e)]);
    });

    image.click();
    assert.equal(lightbox.open, false);
    drawerRoot.click();
    doc.getElementById('away')?.click();

    assert.deepEqual(verdicts, [
      ['IMG', true],
      ['DIV', false],
      ['BUTTON', false]
    ]);
  });
});
