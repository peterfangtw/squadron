import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { modeBitsSkip, tempHome } from '../helpers';

type Names = typeof import('../../core/names');

let home: string;
let names: Names;

const dir = () => path.join(home, '.squadron', 'names');

before(async () => {
  home = await tempHome();
  names = await import('../../core/names');
});

/** Straight past `writeStatedName`, for the shapes it would never write itself. */
async function put(file: string, body: unknown): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(
    path.join(dir(), file),
    typeof body === 'string' ? body : JSON.stringify(body)
  );
}

async function reset(): Promise<void> {
  await fs.rm(dir(), { recursive: true, force: true });
}

describe('the stated-name store', () => {
  it('round-trips a name under its conversation key', async () => {
    await reset();
    assert.equal(await names.writeStatedName('grok', 'sid-1', 'Ship the fold', 1700), true);

    const back = await names.readStatedNames();
    assert.deepEqual(back.get('grok\0sid-1'), {
      schema: 1,
      brand: 'grok',
      sessionId: 'sid-1',
      name: 'Ship the fold',
      statedAt: 1700
    });
  });

  it('keeps two brands sharing one session id apart', async () => {
    await reset();
    await names.writeStatedName('grok', 'same', 'the Grok one', 1);
    await names.writeStatedName('claude', 'same', 'the Claude one', 2);

    const back = await names.readStatedNames();
    assert.equal(back.get('grok\0same')?.name, 'the Grok one');
    assert.equal(back.get('claude\0same')?.name, 'the Claude one');
  });

  it('leaves no temp file behind, and none a watcher would take for one', async () => {
    // The panel watches every `.json` under the state root, subdirectories
    // included: a temp named `.json` would nudge every window on the machine.
    await reset();
    await names.writeStatedName('claude', 'sid-2', 'Read the pipe', 3);
    assert.deepEqual(await fs.readdir(dir()), ['claude.sid-2.json']);
  });

  it('skips a malformed file rather than throwing over it', async () => {
    await reset();
    await names.writeStatedName('claude', 'good', 'kept', 4);
    await put('future.future.json', {
      schema: 1,
      brand: 'future',
      sessionId: 'future',
      name: 'unknown brand',
      statedAt: 5
    });
    await put('claude.half.json', '{"schema":1,"brand":"clau');
    await put('claude.blank.json', { schema: 1, brand: 'claude', sessionId: 'blank', name: '' });
    await put('claude.old.json', {
      schema: 0,
      brand: 'claude',
      sessionId: 'old',
      name: 'from a build that thought differently',
      statedAt: 5
    });

    const back = await names.readStatedNames();
    assert.deepEqual([...back.keys()], ['claude\0good']);
  });

  it('ignores a record whose inner key disagrees with its file name', async () => {
    // A record copied under a name it never described would otherwise answer
    // for a conversation nobody ever renamed.
    await reset();
    await put('claude.mine.json', {
      schema: 1,
      brand: 'claude',
      sessionId: 'somebody-elses',
      name: 'not mine to say',
      statedAt: 6
    });
    await put('grok.sid.json', {
      schema: 1,
      brand: 'claude',
      sessionId: 'sid',
      name: 'wrong brand in the name',
      statedAt: 7
    });

    assert.equal((await names.readStatedNames()).size, 0);
  });

  it('is an empty map on a machine that has named nothing', async () => {
    await reset();
    assert.equal((await names.readStatedNames()).size, 0);
  });

  /**
   * The one thing the host reads off this call, and the only guard against a
   * rename that silently un-renames itself.
   *
   * `host/sessions.ts` keeps `Entry.statedKey` — the id a name has been written
   * under — and skips the write when it already matches. Held over a write that
   * failed, that key retires the one retry there is, and `ui/views.ts` `named`
   * ranks this store *above* the live half's own statement: the record from the
   * previous rename then outranks the new one and every board puts the older
   * name back. So the boolean has to be the truth about the file, not about
   * having tried.
   */
  it('says so when the write cannot land', { skip: modeBitsSkip }, async () => {
    await reset();
    await names.writeStatedName('claude', 'sid-3', 'the first name', 8);
    // Read + execute, so the existing record is still readable and only the
    // write is refused — the shape a full disk or a permissions change has.
    await fs.chmod(dir(), 0o500);
    try {
      assert.equal(await names.writeStatedName('claude', 'sid-3', 'the second name', 9), false);
      assert.equal((await names.readStatedNames()).get('claude\0sid-3')?.name, 'the first name');
    } finally {
      await fs.chmod(dir(), 0o700);
    }
  });
});
