import * as fs from 'node:fs/promises';
import { ReadLimitExceeded } from './index';

export async function readRegular(file: string, maxBytes: number, flags: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('maxBytes must be a nonnegative safe integer');
  const handle = await fs.open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('must be a regular file');
    if (stat.size > maxBytes) throw new ReadLimitExceeded(maxBytes);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new ReadLimitExceeded(maxBytes);
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
