import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, it } from 'node:test';
import type { SessionTransport } from '../../core/session';
import * as fixtures from './incoming_owner_helpers';
import { tempHome } from '../helpers';

let ownership: typeof import('../../core/owned_incoming');
let cwd: string;
before(async () => {
  await tempHome();
  ownership = await import('../../core/owned_incoming');
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'owner-cleanup-')));
});

for (const brand of ['claude', 'grok', 'codex'] as const) {
  for (const failure of ['refused', 'thrown'] as const) {
    it(`${brand} closes its fake CLI when capture is ${failure}`, async (t) => {
      const host = new ownership.IncomingHost('cleanup');
      let spawned: SessionTransport | undefined;
      let isCurrent: (() => boolean) | undefined;
      const error = new Error('capture failed');
      t.mock.method(
        host,
        'capture',
        (...[transport, handle, , current]: Parameters<typeof host.capture>) => {
          spawned = transport;
          isCurrent = current;
          t.after(async () => {
            transport.close();
            handle.close();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                transport.exited,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error('fixture child did not exit')), 5000);
                })
              ]);
            } finally {
              clearTimeout(timer);
            }
          });
          return failure === 'thrown' ? Promise.reject(error) : Promise.resolve(undefined);
        }
      );
      await assert.rejects(
        fixtures.child(host, brand, cwd),
        failure === 'thrown' ? error : { code: 'ERR_ASSERTION' }
      );
      assert.ok(spawned, 'the fixture reached capture with a real transport');
      assert.equal(isCurrent?.(), false);
      assert.equal(spawned.processAlive?.(), false, 'the owned child exited before rejection');
    });
  }
}
