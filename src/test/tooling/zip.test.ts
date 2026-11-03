/**
 * `scripts/zip.mjs` against archives other writers made: .NET's `ZipFile`
 * (sizes in the local header), Windows' bsdtar (data descriptors, directory
 * members, extra fields) and Info-ZIP (directory members alone). vsce's yazl
 * writes descriptors too.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import * as zip from '../../../scripts/zip.mjs';

const MANIFEST = '{"displayName":"Squadron"}';
const BUNDLE = 'tested;'.repeat(40);

const FIXTURES = {
  // Info-ZIP `zip -r` of `extension/dist/` holding nothing: two directory members.
  infozipEmpty:
    'UEsDBAoAAAAAAJ11Wl0AAAAAAAAAAAAAAAAKAAAAZXh0ZW5zaW9uL1BLAwQKAAAAAACddVpdAAAAAAAAAAAAAAAADwAAAGV4dGVuc2lvbi9kaXN0L1BLAQIeAwoAAAAAAJ11Wl0AAAAAAAAAAAAAAAAKAAAAAAAAAAAAEADtQQAAAABleHRlbnNpb24vUEsBAh4DCgAAAAAAnXVaXQAAAAAAAAAAAAAAAA8AAAAAAAAAAAAQAO1BKAAAAGV4dGVuc2lvbi9kaXN0L1BLBQYAAAAAAgACAHUAAABVAAAAAAA=',
  dotnet:
    'UEsDBBQAAAAIANlmWl13DPRlHwAAABoAAAAWAAAAZXh0ZW5zaW9uL3BhY2thZ2UuanNvbgEaAOX/eyJkaXNwbGF5TmFtZSI6IlNxdWFkcm9uIn1QSwMEFAAAAAgA2WZaXY26ZdgNAAAAGAEAABsAAABleHRlbnNpb24vZGlzdC9leHRlbnNpb24uanMrSS0uSU2xLhmlUCkAUEsBAhQAFAAAAAgA2WZaXXcM9GUfAAAAGgAAABYAAAAAAAAAAAAAAAAAAAAAAGV4dGVuc2lvbi9wYWNrYWdlLmpzb25QSwECFAAUAAAACADZZlpdjbpl2A0AAAAYAQAAGwAAAAAAAAAAAAAAAABTAAAAZXh0ZW5zaW9uL2Rpc3QvZXh0ZW5zaW9uLmpzUEsFBgAAAAACAAIAjQAAAJkAAAAAAA==',
  bsdtar:
    'UEsDBBQAAAAAANlmWl0AAAAAAAAAAAAAAAAKACAAZXh0ZW5zaW9uL3V4CwABBAAAAAAEAAAAAFVUDQAHGt3eahrd3moa3d5qUEsDBBQAAAAAANlmWl0AAAAAAAAAAAAAAAAPACAAZXh0ZW5zaW9uL2Rpc3QvdXgLAAEEAAAAAAQAAAAAVVQNAAca3d5qGt3eahrd3mpQSwMEFAAIAAgA2WZaXQAAAAAAAAAAAAAAABYAIABleHRlbnNpb24vcGFja2FnZS5qc29udXgLAAEEAAAAAAQAAAAAVVQNAAca3d5qGt3eahrd3mqrVkrJLC7ISaz0S8xNVbJSCi4sTUwpys9TqgUAUEsHCHcM9GUcAAAAGgAAAFBLAwQUAAgACADZZlpdAAAAAAAAAAAAAAAAGwAgAGV4dGVuc2lvbi9kaXN0L2V4dGVuc2lvbi5qc3V4CwABBAAAAAAEAAAAAFVUDQAHGt3eahrd3moa3d5qK0ktLklNsS4ZpVApAFBLBwiNumXYDQAAABgBAABQSwECFAMUAAAAAADZZlpdAAAAAAAAAAAAAAAACgAYAAAAAAAAAAAA/0EAAAAAZXh0ZW5zaW9uL3V4CwABBAAAAAAEAAAAAFVUBQABGt3ealBLAQIUAxQAAAAAANlmWl0AAAAAAAAAAAAAAAAPABgAAAAAAAAAAAD/QUgAAABleHRlbnNpb24vZGlzdC91eAsAAQQAAAAABAAAAABVVAUAARrd3mpQSwECFAMUAAgACADZZlpddwz0ZRwAAAAaAAAAFgAYAAAAAAAAAAAAtoGVAAAAZXh0ZW5zaW9uL3BhY2thZ2UuanNvbnV4CwABBAAAAAAEAAAAAFVUBQABGt3ealBLAQIUAxQACAAIANlmWl2NumXYDQAAABgBAAAbABgAAAAAAAAAAAC2gRUBAABleHRlbnNpb24vZGlzdC9leHRlbnNpb24uanN1eAsAAQQAAAAABAAAAABVVAUAARrd3mpQSwUGAAAAAAQABABiAQAAiwEAAAAA'
};

async function fixture(name: keyof typeof FIXTURES): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-zip-'));
  const file = path.join(dir, `${name}.zip`);
  await fs.writeFile(file, Buffer.from(FIXTURES[name], 'base64'));
  return { dir, file };
}

describe('zip', () => {
  for (const name of ['dotnet', 'bsdtar'] as const) {
    it(`extracts and rewrites one member of a ${name} archive`, async () => {
      const { dir, file } = await fixture(name);
      try {
        const out = path.join(dir, 'out');
        assert.equal(zip.extract(file, 'extension/dist/', out), 1);
        assert.equal(
          await fs.readFile(path.join(out, 'extension/dist/extension.js'), 'utf8'),
          BUNDLE
        );
        assert.deepEqual(await fs.readdir(path.join(out, 'extension')), ['dist']);

        zip.replace(
          file,
          'extension/package.json',
          Buffer.from('{"displayName":"Squadron (STG)"}')
        );
        assert.equal(
          zip.entry(file, 'extension/package.json').toString(),
          '{"displayName":"Squadron (STG)"}'
        );
        assert.equal(zip.entry(file, 'extension/dist/extension.js').toString(), BUNDLE);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('creates an empty directory member under the prefix, as unzip does', async () => {
    const { dir, file } = await fixture('infozipEmpty');
    try {
      const out = path.join(dir, 'out');
      assert.equal(zip.extract(file, 'extension/dist/', out), 0);
      assert.deepEqual(await fs.readdir(path.join(out, 'extension/dist')), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a member name that climbs out with backslashes', async () => {
    const { dir, file } = await fixture('dotnet');
    try {
      // Same length as the name it replaces, so every offset still holds. On
      // win32 `join` splits it on `\` and lands one level above `out`.
      const bytes = (await fs.readFile(file))
        .toString('latin1')
        .replaceAll('extension/dist/extension.js', 'extension/dist/..\\..\\..\\esc');
      await fs.writeFile(file, Buffer.from(bytes, 'latin1'));
      const out = path.join(dir, 'out');
      assert.throws(() => zip.extract(file, 'extension/dist/', out), /escapes the archive/);
      assert.deepEqual(await fs.readdir(dir), ['dotnet.zip']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to copy a member whose recorded size runs past its data', async () => {
    const { dir, file } = await fixture('dotnet');
    try {
      const bytes = await fs.readFile(file);
      // The bundle is the last member, so the bytes past its deflate stream are
      // the central directory: inflate stops at the stream's end and the CRC
      // still matches. Only the bound on member data refuses it.
      const central = bytes.lastIndexOf('extension/dist/extension.js') - 46;
      bytes.writeUInt32LE(10_000, central + 20);
      await fs.writeFile(file, bytes);
      assert.throws(
        () => zip.replace(file, 'extension/package.json', Buffer.from('{}')),
        /runs past/
      );
      assert.deepEqual(await fs.readFile(file), bytes);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to copy a member whose recorded size stops short of its data', async () => {
    const { dir, file } = await fixture('dotnet');
    try {
      const bytes = await fs.readFile(file);
      // The manifest is the first member: its short copy would still sit
      // inside member data, and the rewritten archive would not inflate.
      const central = bytes.lastIndexOf('extension/package.json') - 46;
      bytes.writeUInt32LE(bytes.readUInt32LE(central + 20) - 3, central + 20);
      await fs.writeFile(file, bytes);
      assert.throws(
        () => zip.replace(file, 'extension/dist/extension.js', Buffer.from(BUNDLE)),
        /extension\/package\.json does not inflate/
      );
      assert.deepEqual(await fs.readFile(file), bytes);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('raises the version a rewritten member needs to the one deflate needs', async () => {
    const { dir, file } = await fixture('dotnet');
    try {
      // As a writer that stored the manifest would have recorded it: method 0,
      // version 1.0. The old bytes are never read, so they can stay deflated.
      const bytes = await fs.readFile(file);
      const central = bytes.lastIndexOf('extension/package.json') - 46;
      bytes.writeUInt16LE(10, 4);
      bytes.writeUInt16LE(0, 8);
      bytes.writeUInt16LE(10, central + 6);
      bytes.writeUInt16LE(0, central + 10);
      await fs.writeFile(file, bytes);
      zip.replace(file, 'extension/package.json', Buffer.from('{}'));
      const out = await fs.readFile(file);
      assert.equal(out.readUInt16LE(4), 20);
      assert.equal(out.readUInt16LE(out.lastIndexOf('extension/package.json') - 46 + 6), 20);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a member whose bytes do not match its CRC', async () => {
    const { dir, file } = await fixture('dotnet');
    try {
      assert.equal(zip.entry(file, 'extension/package.json').toString(), MANIFEST);
      const bytes = await fs.readFile(file);
      // .NET stored the manifest as one uncompressed deflate block; byte 76 is
      // inside its JSON, so flipping it changes the content but not the framing.
      bytes[76] = (bytes[76] ?? 0) ^ 0x20;
      await fs.writeFile(file, bytes);
      assert.throws(() => zip.entry(file, 'extension/package.json'), /CRC/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
