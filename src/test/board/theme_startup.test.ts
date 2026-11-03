import * as assert from 'node:assert/strict';
import * as test from 'node:test';
import * as jsdom from 'jsdom';
import * as themes from '../../core/theme_names';
import * as document from '../../ui/document';

test.describe('the initial panel theme', () => {
  for (const theme of themes.THEME_NAMES) {
    test.it(`includes ${theme} before scripts or host state run`, () => {
      const dom = new jsdom.JSDOM(document.panelDocument('', undefined, theme));
      try {
        assert.equal(
          dom.window.document.body.dataset.theme,
          theme === 'follow' ? undefined : theme
        );
        assert.ok(dom.window.document.querySelector('#cards[aria-busy="true"]'));
      } finally {
        dom.window.close();
      }
    });
  }
});
