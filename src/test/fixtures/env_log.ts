/**
 * The environment a fake CLI was started with, one JSON object per spawn,
 * appended to the file `FAKE_ENV_LOG` names. Shared by `fake-cli`, `fake-acp`
 * and `fake-codex`, so a test reads every brand's children in one file.
 *
 * The only witness to what a child was handed: `remote_flows.test.ts`
 * searches it for a messenger credential that must never reach a session.
 * Only where a test named a file, as `FAKE_CLI_ARGV` is — a fixture guessing
 * at a path would leave a file in whatever `HOME` other suites point at.
 */

import * as fs from 'node:fs';

export function logEnvironment(): void {
  const file = process.env.FAKE_ENV_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(process.env) + '\n');
  } catch {
    // A fixture that cannot write its log still has a session to run.
  }
}
