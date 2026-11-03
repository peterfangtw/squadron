import * as assert from 'node:assert/strict';

import * as fs from 'node:fs/promises';

import * as os from 'node:os';

import * as path from 'node:path';

import { after, before, describe, it } from 'node:test';

import { isMarker, type Authored } from '../../core/transcript';

import { dispose, fromRows, readGrokTranscript, setup } from './grok_transcript_helpers';

before(setup);

after(dispose);

describe('Grok user-turn images', () => {
  const shot =
    '/Users/me/.grok/sessions/proj/019fe76a/assets/image-5b884f71-5a14-4a16-8413-d3bf176992b5.png';

  async function fromRows(rows: unknown[]): Promise<string> {
    const file = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-img-')),
      'chat_history.jsonl'
    );
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return file;
  }

  it('names the path in <image_files>, not the sibling data URL', async () => {
    const file = await fromRows([
      {
        type: 'user',
        content: [
          {
            type: 'text',
            text: `<image_files>\nThe following images were provided by the user and saved to the workspace for future use:\n1. ${shot}\n\nThese images can be copied for use in other locations.\n</image_files>\n\n<user_query>\nthere might be a bug [Image #1] in settings\n</user_query>`
          },
          { type: 'image', url: `data:image/png;base64,${'A'.repeat(8000)}` }
        ]
      }
    ]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
    assert.equal(exchanges.length, 1);
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.text, 'there might be a bug [Image #1] in settings');
    assert.deepEqual(turn.images, [{ id: `p|${shot}` }]);
    assert.equal(JSON.stringify(turn).includes('data:image'), false);
  });

  it('keeps an image-only turn, with no empty prose block', async () => {
    const file = await fromRows([
      {
        type: 'user',
        content: [
          {
            type: 'text',
            text: `<image_files>\n1. ${shot}\n</image_files>\n\n<user_query>\n\n</user_query>`
          }
        ]
      }
    ]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.text, '');
    assert.equal(turn.blocks, undefined);
    assert.deepEqual(turn.images, [{ id: `p|${shot}` }]);
  });

  it('names every numbered path, in order', async () => {
    const second = '/tmp/other.jpg';
    const file = await fromRows([
      {
        type: 'user',
        content: [
          {
            type: 'text',
            text: `<image_files>\n1. ${shot}\n2. ${second}\n</image_files>\n<user_query>\nlook\n</user_query>`
          }
        ]
      }
    ]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(path.dirname(file), { recursive: true, force: true });
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.deepEqual(turn.images, [{ id: `p|${shot}` }, { id: `p|${second}` }]);
  });
});

describe('Grok assistant-turn images', () => {
  const drawn = (turn: Authored): string =>
    (turn.blocks ?? []).flatMap((block) => ('text' in block ? [block.text] : [])).join('');

  it('turns an absolute path into a ref and takes the syntax out of the prose', async () => {
    const { file, root } = await fromRows([
      { type: 'assistant', content: 'here it is:\n\n![render](/tmp/a.png)\n\ndone' }
    ]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(root, { recursive: true, force: true });
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.deepEqual(turn.images, [{ id: 'f|sid.g0|0.0|/tmp/a.png' }]);
    assert.doesNotMatch(drawn(turn), /!\[|a\.png/);
    assert.match(drawn(turn), /here it is:/);
    assert.match(drawn(turn), /done/);
    assert.match(turn.text, /!\[render\]\(\/tmp\/a\.png\)/, 'text keeps the syntax');
  });

  it('resolves a relative path against the cwd in the session dir', async () => {
    const cwd = path.resolve('/Users/me/src/notes-app');
    const { file, root } = await fromRows(
      [{ type: 'assistant', content: '![Aperture](.impeccable/mocks/comp-mill-aperture.jpg)' }],
      cwd
    );
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(root, { recursive: true, force: true });
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.deepEqual(turn.images, [
      {
        id: `f|sid.g0|0.0|${path.join(cwd, '.impeccable', 'mocks', 'comp-mill-aperture.jpg')}`
      }
    ]);
    assert.equal(drawn(turn), '', 'an image-only turn draws its chip with no empty row');
  });

  it('names every image in one reply, in order', async () => {
    const { file, root } = await fromRows([
      {
        type: 'assistant',
        content:
          '**A — Aperture.**\n\n![Aperture](/tmp/a.jpg)\n\n**B — Folio.**\n\n![Folio](/tmp/b.jpg)'
      }
    ]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(root, { recursive: true, force: true });
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.deepEqual(turn.images, [
      { id: 'f|sid.g0|0.0|/tmp/a.jpg' },
      { id: 'f|sid.g0|0.1|/tmp/b.jpg' }
    ]);
  });

  it('demotes a remote image to a link, so nothing asks the network for it', async () => {
    const { file, root } = await fromRows([
      { type: 'assistant', content: '![web](https://example.com/e.png)' }
    ]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(root, { recursive: true, force: true });
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.images, undefined);
    assert.equal(drawn(turn), '[web](https://example.com/e.png)');
  });

  it('numbers the uuid by the assistant turn, so two renders of one file differ', async () => {
    const { file, root } = await fromRows([
      { type: 'assistant', content: '![one](/tmp/shot.png)' },
      { type: 'assistant', content: '![two](/tmp/shot.png)' }
    ]);
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(root, { recursive: true, force: true });
    assert.deepEqual(
      exchanges.flatMap((x) => (!isMarker(x) ? [x.images?.[0]?.id] : [])),
      ['f|sid.g0|0.0|/tmp/shot.png', 'f|sid.g1|0.0|/tmp/shot.png']
    );
  });

  it('leaves a relative dest as a link when the file is not in a session dir', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'av-grok-md-flat-'));
    const file = path.join(root, 'chat_history.jsonl');
    await fs.writeFile(
      file,
      JSON.stringify({ type: 'assistant', content: '![shot](out/b.png)' }) + '\n'
    );
    const { exchanges } = await readGrokTranscript(file);
    await fs.rm(root, { recursive: true, force: true });
    const turn = exchanges[0];
    assert.ok(turn && !isMarker(turn));
    assert.equal(turn.images, undefined);
    assert.equal(drawn(turn), '[shot](out/b.png)');
  });
});
