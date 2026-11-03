import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { dropdownTrigger, opensMenu } from '../../webview/kit';

describe('dropdown trigger UI', () => {
  it('can be relabelled and used with a caller-owned popover', (t) => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: dom.window.document
    });
    t.after(() => {
      dom.window.close();
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    });

    const control = dropdownTrigger('Model', 'model');
    assert.equal(control.button.type, 'button');
    assert.equal(control.button.className, 'fpill model');
    assert.equal(control.button.hasAttribute('aria-haspopup'), false);
    assert.equal(control.wrap.querySelector('.fmenu'), null);

    const popover = dom.window.document.createElement('div');
    popover.hidden = true;
    control.wrap.append(popover);
    control.button.onclick = () => {
      popover.hidden = !popover.hidden;
    };
    const label = control.label;
    control.label.textContent = 'Astra';
    assert.equal(control.button.querySelector('.nm'), label);
    control.button.click();
    assert.equal(popover.hidden, false);
    assert.equal(control.caret.textContent, '▾');
  });

  it('composes with the shared menu without owning its contents', (t) => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: dom.window.document
    });
    t.after(() => {
      dom.window.close();
      if (previous) Object.defineProperty(globalThis, 'document', previous);
      else Reflect.deleteProperty(globalThis, 'document');
    });

    const control = dropdownTrigger('Effort');
    const menu = opensMenu(control.wrap, control.button, 'start', () => {});
    control.wrap.append(menu);
    assert.equal(control.button.getAttribute('aria-haspopup'), 'menu');
    assert.equal(control.button.getAttribute('aria-expanded'), 'false');
    assert.equal(menu.hidden, true);
    assert.equal(menu.getAttribute('role'), 'menu');
  });
});
