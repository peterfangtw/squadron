/**
 * One compiled module against the tests written for it.
 *
 * Mutants are placed in the compiled `out/` JavaScript. A `.ts` mutant would
 * rebuild on every one, and `scripts/mutate.mjs` runs `npm run compile` once before Stryker
 * starts. node:test has no Stryker runner, so this uses the command runner
 * that ships in `@stryker-mutator/core`. That runner cannot report which
 * tests cover a line, so coverage analysis is off and every mutant runs the
 * test files named here.
 *
 * Add a module by adding one row to `PAIRS`. `npm run mutate -- <name>`.
 * `thresholds.break` stays null: this is a report, and `npm run check` does
 * not call it.
 */

/** @type {Record<string, { mutate: string, tests: string[] }>} */
export const PAIRS = {
  views: {
    mutate: 'out/ui/views.js',
    tests: [
      'out/test/views/views.test.js',
      'out/test/views/views_groups.test.js',
      'out/test/views/views_servers.test.js',
      'out/test/views/views_notifications.test.js',
      'out/test/views/views_thread.test.js',
      'out/test/views/views_twins.test.js'
    ]
  }
};

/**
 * @param {string} name
 * @returns {{ mutate: string, tests: string[] }}
 */
export function pairFor(name) {
  const pair = PAIRS[name];
  if (!pair) {
    throw new Error(`unknown module "${name}". Known: ${Object.keys(PAIRS).join(', ')}.`);
  }
  return pair;
}

const pair = pairFor(process.env.MUTATE ?? 'views');

export default {
  testRunner: 'command',
  commandRunner: { command: `node --test ${pair.tests.join(' ')}` },
  coverageAnalysis: 'off',
  mutate: [pair.mutate],
  // Compiled JS is not type-checked. Leaving this on inserts `@ts-nocheck`
  // and shifts the lines the report attributes.
  disableTypeChecks: false,
  tempDirName: '.stryker-tmp',
  reporters: ['progress', 'clear-text', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 80, low: 60, break: null },
  // The test files load `out/` and resolve packages through the symlinked
  // `node_modules`. These trees are not on that path.
  ignorePatterns: ['dist', 'dist-releases', 'docs', 'media', '.worktrees', 'reports']
};
