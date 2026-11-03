import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proseBlockView } from '../../ui/turn_blocks';

describe('proseBlockView', () => {
  const rendered: string[] = [];
  const render = (text: string): Promise<string> => {
    rendered.push(text);
    return Promise.resolve(`<p>${text}</p>`);
  };

  it('sends a user turn as its source, never through the engine', async () => {
    rendered.length = 0;
    assert.deepEqual(await proseBlockView('user', false, { text: 'see **x**' }, render), {
      prose: 'see **x**'
    });
    assert.deepEqual(rendered, []);
  });

  it('takes the attachment paths out of a user turn with images', async () => {
    const text = 'look at this\n/tmp/pastes/a.png';
    assert.deepEqual(await proseBlockView('user', true, { text }, render), {
      prose: 'look at this'
    });
  });

  it('keeps a path in a user turn with no images', async () => {
    const text = 'look at this\n/tmp/pastes/a.png';
    assert.deepEqual(await proseBlockView('user', false, { text }, render), { prose: text });
  });

  it('renders an assistant turn, keeping its paths and its summarized flag', async () => {
    const text = 'built it\n/tmp/out.png';
    assert.deepEqual(await proseBlockView('assistant', true, { text, summarized: true }, render), {
      html: `<p>${text}</p>`,
      summarized: true
    });
  });

  it('renders a cli turn', async () => {
    assert.deepEqual(await proseBlockView('cli', false, { text: '| a |' }, render), {
      html: '<p>| a |</p>'
    });
  });
});
