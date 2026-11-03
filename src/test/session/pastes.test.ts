import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';

type Pastes = typeof import('../../core/pastes');

let home: string;
let pastes: Pastes;
let dir: string;

before(async () => {
  home = await tempHome();
  pastes = await import('../../core/pastes');
  dir = path.join(home, '.squadron', 'pastes');
});

/** A one-pixel PNG, as the composer would hand it over. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const dataUrl = (mediaType: string, bytes = PNG_BYTES) =>
  `data:${mediaType};base64,${bytes.toString('base64')}`;

describe('extForMedia', () => {
  it('maps the types the CLI will attach', () => {
    assert.equal(pastes.extForMedia('image/png'), 'png');
    assert.equal(pastes.extForMedia('image/jpeg'), 'jpg');
    assert.equal(pastes.extForMedia('image/gif'), 'gif');
    assert.equal(pastes.extForMedia('image/webp'), 'webp');
  });

  it('refuses a type the CLI would read and then drop', () => {
    assert.equal(pastes.extForMedia('image/bmp'), undefined);
    assert.equal(pastes.extForMedia('image/svg+xml'), undefined);
    assert.equal(pastes.extForMedia('text/plain'), undefined);
  });
});

describe('imagePathsIn', () => {
  it('sees a path on its own', () => {
    assert.deepEqual(pastes.imagePathsIn('/tmp/shot.png'), ['/tmp/shot.png']);
  });

  it('sees a path after prose, the way the composer composes one', () => {
    assert.deepEqual(pastes.imagePathsIn('why is this clipped?\n\n/tmp/a.png'), ['/tmp/a.png']);
  });

  it('sees a path typed by hand at the end of a sentence', () => {
    assert.deepEqual(pastes.imagePathsIn('look at /tmp/a.jpeg'), ['/tmp/a.jpeg']);
  });

  // The CLI splits ahead of a path but not after it, so a path with words
  // trailing it stays one token and fails the extension test — it is sent as
  // plain text and attaches nothing. Which is why the composer puts each path
  // at the end of its own line.
  it('leaves a path with words after it alone, as the CLI does', () => {
    assert.deepEqual(pastes.imagePathsIn('look at /tmp/a.jpeg and tell me'), []);
  });

  it('leaves ordinary prose alone', () => {
    assert.deepEqual(pastes.imagePathsIn('nothing to attach here'), []);
    assert.deepEqual(pastes.imagePathsIn('read notes.txt'), []);
  });

  it('ignores extensions the CLI does not gate on', () => {
    assert.deepEqual(pastes.imagePathsIn('/tmp/a.bmp'), []);
    assert.deepEqual(pastes.imagePathsIn('/tmp/a.svg'), []);
  });
});

describe('writePastedImage', () => {
  it('writes the bytes and answers with the path', async () => {
    const file = await pastes.writePastedImage({
      mediaType: 'image/png',
      dataUrl: dataUrl('image/png')
    });
    assert.ok(file, 'expected a path');
    assert.equal(path.dirname(file), dir);
    assert.equal(path.extname(file), '.png');
    assert.deepEqual(await fs.readFile(file), PNG_BYTES);
  });

  it('names the file by media type, not by what it was called', async () => {
    const file = await pastes.writePastedImage({
      mediaType: 'image/jpeg',
      dataUrl: dataUrl('image/jpeg')
    });
    assert.equal(path.extname(file ?? ''), '.jpg');
  });

  it('writes nothing for a type the CLI would drop', async () => {
    assert.equal(
      await pastes.writePastedImage({ mediaType: 'image/bmp', dataUrl: dataUrl('image/bmp') }),
      undefined
    );
  });

  it('writes nothing for a data URL that does not parse', async () => {
    assert.equal(
      await pastes.writePastedImage({ mediaType: 'image/png', dataUrl: 'not-a-data-url' }),
      undefined
    );
    assert.equal(
      await pastes.writePastedImage({ mediaType: 'image/png', dataUrl: 'data:image/png;base64,' }),
      undefined
    );
  });
});

describe('prunePastes', () => {
  it('drops what is old and keeps what is fresh', async () => {
    const fresh = await pastes.writePastedImage({
      mediaType: 'image/png',
      dataUrl: dataUrl('image/png')
    });
    const old = await pastes.writePastedImage({
      mediaType: 'image/png',
      dataUrl: dataUrl('image/png')
    });
    assert.ok(fresh && old);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(old, twoDaysAgo, twoDaysAgo);

    await pastes.prunePastes();

    assert.equal(await fs.stat(fresh).then(() => true), true);
    await assert.rejects(fs.stat(old));
  });

  it('says nothing when nobody has pasted on this machine', async () => {
    await assert.doesNotReject(pastes.prunePastes());
  });
});
