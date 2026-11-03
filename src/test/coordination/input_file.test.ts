import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as inputFile from '../../cli/input_file';

describe('--argv-file', () => {
  let dir: string;
  const write = async (name: string, bytes: string | Buffer) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, bytes);
    return file;
  };
  const read = (raw: readonly string[]) => inputFile.commandArgv(raw);

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "argv 中文 & it's "));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('leaves a command line that names no file untouched', async () => {
    const raw = ['--text', 'two\nlines', '--pid', '7'];
    assert.deepEqual(await read(raw), { ok: true, argv: raw });
  });

  it('reads a UTF-8 JSON array of strings, one initial BOM consumed', async () => {
    const argv = ['--text', 'line one\nline "two"\\', '', '日本 😀', '--argv-files-are-ok'];
    for (const prefix of ['', '﻿']) {
      const file = await write(`args${prefix.length}.json`, prefix + JSON.stringify(argv));
      assert.deepEqual(await read(['--argv-file', file]), { ok: true, argv });
    }
    assert.deepEqual(await read(['--argv-file', await write('empty.json', '[]')]), {
      ok: true,
      argv: []
    });
  });

  it('refuses a file beside other arguments, inside itself, or unread', async () => {
    const good = await write('good.json', '["--help"]');
    const refusals: [readonly string[], RegExp][] = [
      [['--pid', '7', '--argv-file', good], /must be the only arguments/],
      [['--argv-file', good, '--help'], /must be the only arguments/],
      [['--argv-file'], /must be the only arguments/],
      [[`--argv-file=${good}`], /must be the only arguments/],
      [['--argv-file', await write('nested.json', JSON.stringify(['--argv-file', good]))], /again/],
      [['--argv-file', await write('eq.json', '["--argv-file=x"]')], /again/],
      [['--argv-file', await write('object.json', '{"argv":[]}')], /JSON array of strings/],
      [['--argv-file', await write('number.json', '["--pid", 7]')], /JSON array of strings/],
      [['--argv-file', await write('bad.json', '["x"')], /--argv-file: /],
      [
        ['--argv-file', await write('latin1.json', Buffer.from([0x5b, 0x22, 0xe9, 0x22, 0x5d]))],
        /--argv-file: /
      ],
      [['--argv-file', path.join(dir, 'missing.json')], /--argv-file: /],
      [['--argv-file', dir], /regular file/]
    ];
    for (const [raw, why] of refusals) {
      const result = await read(raw);
      assert.equal(result.ok, false, JSON.stringify(raw));
      if (!result.ok) assert.match(result.reason, why, JSON.stringify(raw));
    }
  });

  it('accepts exactly 96 KiB including the BOM, and refuses one byte more', async () => {
    const fill = (bytes: number) => {
      const bom = String.fromCharCode(0xfeff);
      return `${bom}["${'a'.repeat(bytes - Buffer.byteLength(`${bom}[""]`))}"]`;
    };
    const at = await write('at.json', fill(inputFile.INPUT_FILE_MAX_BYTES));
    assert.equal((await fs.stat(at)).size, 98_304);
    assert.equal((await read(['--argv-file', at])).ok, true);
    const over = await read(['--argv-file', await write('over.json', fill(98_305))]);
    assert.equal(over.ok, false);
    if (!over.ok) assert.match(over.reason, /exceeds 98304 bytes/);
  });
});
