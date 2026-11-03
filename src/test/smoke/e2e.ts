/**
 * End-to-end smoke: a real IDE binary, the real extension, a real fixture
 * session, and a real child on a real pipe. Deliberately few tests — behaviour
 * coverage lives in the jsdom suite (`workflow_chat.test.ts`,
 * `workflow_overview_drawer.test.ts`); this proves the stack stands up against a host
 * rather than a stub. Machine-dependent: needs one of `boot.ts`'s `IDES`
 * installed, so it runs via `npm run test:smoke`, never in `npm run check`.
 *
 * This file is the whole suite and nothing else: `boot.ts` launches one host,
 * and each import below adds its scenarios to this process. To work on one of
 * them, run that file directly — it boots a host of its own:
 *
 *     npm run test:smoke:one -- out/test/smoke/servers.smoke.js
 *
 * The supervisor accepts one compiled scenario or this barrel and rejects
 * globs. Raw `node --test` invocation of a boot consumer is refused before
 * fixture work; use the npm entry points above.
 *
 * **Order carries nothing.** Each file is a `section` (`boot.ts`), and every
 * section after the first starts on a host reset to the planted state — editors,
 * terminals and panel shut, `HOME` and `settings.json` put back, the window
 * reloaded, or a new IDE if the last section went red. So no file sets up
 * another, and none has to be immune to one before it. The order below is only
 * the order they were written in.
 *
 * Slow motion (watch the clicks): `SQUADRON_SMOKE_SLOW=<ms>` adds that many
 * milliseconds between Playwright actions — e.g.
 * `SQUADRON_SMOKE_SLOW=250 npm run test:smoke`. Unset or `0` is full speed.
 *
 * Nothing here is named `*.test.ts` on purpose: no future recursive test glob
 * can pull an IDE launch into the pre-commit hook.
 */

import * as registry from './scenarios';

// Validate before any scenario import: importing one starts the supervised host.
const selection = registry.scenarioSelection(
  process.env['SQUADRON_SMOKE_ENTRIES']
    ? (JSON.parse(process.env['SQUADRON_SMOKE_ENTRIES']) as unknown)
    : undefined
);
for (const name of selection) {
  // Ordered registration in one worker preserves the shared supervised host.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./' + name);
}
