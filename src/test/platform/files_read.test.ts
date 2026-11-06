import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as platform from '../../core/platform';
import { ReadLimitExceeded } from '../../core/platform/files';

describe('bounded regular-file bytes', () => {
  let directory: string;
  before(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'regular-bytes-'));
  });
  after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('returns raw bytes up to the caller limit, including an empty file', async () => {
    const file = path.join(directory, 'bytes');
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0x00, 0xfe])]) {
      await fs.writeFile(file, bytes);
      assert.deepEqual(await platform.files.readRegular(file, 3), bytes);
    }
    await assert.rejects(platform.files.readRegular(file, 2), /exceeds 2 bytes/);
  });

  it('rejects directories and propagates missing-file errors', async () => {
    await assert.rejects(platform.files.readRegular(directory, 3), /regular file/);
    await assert.rejects(platform.files.readRegular(path.join(directory, 'missing'), 3), {
      code: 'ENOENT'
    });
  });

  for (const outcome of ['growth', 'read failure'] as const) {
    it(`closes its handle after ${outcome}, bounding bytes beyond the initial stat`, async (context) => {
      let readBytes = 0;
      let closed = false;
      const failure = new Error('read failed');
      context.mock.method(fs, 'open', () =>
        Promise.resolve({
          stat: () => Promise.resolve({ isFile: () => true, size: 0 }),
          read: (buffer: Buffer, offset: number, length: number) => {
            if (outcome === 'read failure') return Promise.reject(failure);
            const bytesRead = Math.min(length, 2);
            buffer.fill(1, offset, offset + bytesRead);
            readBytes += bytesRead;
            return Promise.resolve({ bytesRead, buffer });
          },
          close: () => {
            closed = true;
            return Promise.resolve();
          }
        })
      );
      await assert.rejects(platform.files.readRegular('growing-file', 3), (error) =>
        outcome === 'growth' ? error instanceof ReadLimitExceeded : error === failure
      );
      assert.equal(readBytes, outcome === 'growth' ? 4 : 0);
      assert.equal(closed, true);
    });
  }
});
