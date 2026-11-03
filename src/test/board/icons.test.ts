import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { icon, iconForFile } from '../../ui/icons';

describe('iconForFile', () => {
  it('reads the extension, not the path around it', () => {
    assert.equal(iconForFile('/a/b/runs.test.ts'), 'code');
    assert.equal(iconForFile('C:\\x\\y\\panel.TSX'), 'code');
    assert.equal(iconForFile('~/shots/screenshot-2026-08-01.png'), 'image');
    assert.equal(iconForFile('/repo/README.md'), 'md');
  });

  it('names nothing for a kind the pill should not guess at', () => {
    assert.equal(iconForFile('/repo/LICENSE'), null);
    assert.equal(iconForFile('/repo/.gitignore'), null);
    assert.equal(iconForFile('/repo/notes.wat'), null);
  });

  it('emits paths only, so every glyph strokes the same way', () => {
    for (const name of ['image', 'code', 'md'] as const) {
      const svg = icon(name, 13);
      assert.match(svg, /width="13" height="13"/);
      assert.equal(svg.includes('<rect'), false);
      assert.equal(svg.includes('<circle'), false);
    }
  });
});
