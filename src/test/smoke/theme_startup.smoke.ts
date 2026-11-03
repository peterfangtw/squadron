import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import * as helpers from '../helpers';
import * as boot from './boot';

boot.section('the saved theme at panel startup', () => {
  boot.step('loads the folder theme before the first host state', async () => {
    const folder = path.join(boot.homeDir(), 'project');
    const key = platform.paths.key(folder);
    const file = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) + '.json';
    await helpers.writeJson(path.join(boot.homeDir(), '.squadron', 'themes', file), {
      schema: 1,
      folder,
      theme: 'paper'
    });
    await boot.patchSettings({ 'squadron.theme': 'ink' });
    await boot.ctx.page.context().addInitScript(() => {
      // document.open clears window listeners; intercept registration as the host-state gate does.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const add = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
      ): void {
        if (this === window && type === 'message' && document.getElementById('cards')) {
          document.body.dataset.smokeInitialTheme ??= document.body.dataset.theme ?? 'follow';
        }
        add.call(this, type, listener, options);
      };
    });

    for (let opening = 0; opening < 2; opening++) {
      await boot.openPanel();
      assert.equal(
        await boot.panel().locator('body').getAttribute('data-smoke-initial-theme'),
        'paper'
      );
      await boot.panel().locator('#cards[aria-busy="false"]').waitFor({ timeout: 30_000 });
      assert.equal(await boot.panel().locator('body').getAttribute('data-theme'), 'paper');
      await boot.closeEditors();
    }
  });
});
