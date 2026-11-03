import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { procStartFor } from '../helpers';
import { HOST_OWNED } from '../smoke/host_owned';
import * as ownership from '../smoke/ownership';
import { procStart } from '../smoke/process_start';
import * as seedFiles from '../smoke/seed';

it('encodes the witnessed native start and refuses a missing process', async () => {
  const row = (await ownership.readProcesses()).get(process.pid);
  assert.ok(row);
  assert.equal(await procStart(process.pid), procStartFor(row.startedAt));
  await assert.rejects(procStart(-1), /absent from the native snapshot/);
});

it('retains open host storage through repeated restores while deleting fixture additions', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-reset-')));
  const seed = path.join(root, 'seed');
  const home = path.join(root, 'home');
  const storage = path.join(home, '.vscode-shared', 'sharedStorage');
  await fs.mkdir(seed);
  await fs.mkdir(storage, { recursive: true });
  const database = path.join(storage, 'state.vscdb');
  await fs.writeFile(database, 'host state');
  const handle = await fs.open(database, 'r');
  try {
    await fs.writeFile(path.join(seed, 'fixture'), 'seed');
    for (let pass = 0; pass < 2; pass++) {
      await fs.writeFile(path.join(home, 'extra'), 'delete');
      seedFiles.restore(seed, home, HOST_OWNED);
      assert.equal(await fs.readFile(database, 'utf8'), 'host state');
      assert.equal(await fs.readFile(path.join(home, 'fixture'), 'utf8'), 'seed');
      assert.equal(await fs.stat(path.join(home, 'extra')).catch(() => undefined), undefined);
      assert.deepEqual(seedFiles.drift(seed, home, HOST_OWNED), []);
    }
  } finally {
    await handle.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
