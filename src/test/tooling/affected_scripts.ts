/** What `scripts/affected.mjs` loads beside itself, for a fixture repo that runs it. */
export const AFFECTED_SCRIPTS: readonly string[] = [
  'affected.mjs',
  'fixture-roots.cjs',
  'checkpoints.mjs',
  'test-results.mjs',
  'verification_processes.mjs',
  'checkpoint-reporter.mjs',
  'observation.mjs',
  'skip-reporter.mjs',
  'skip-scopes.cjs'
];
