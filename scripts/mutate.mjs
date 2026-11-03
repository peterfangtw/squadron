#!/usr/bin/env node
/**
 * Compile once, then mutation-test one module against the tests written for it.
 *
 * `npm run mutate` is `views`. `npm run mutate -- <name>` selects a row in
 * `scripts/stryker.config.mjs`. The name is checked before the compile, so a
 * typo does not pay for a build.
 */
import { spawnSync } from 'node:child_process';

const name = process.argv[2] ?? process.env.MUTATE ?? 'views';
process.env.MUTATE = name;

try {
  const { pairFor } = await import('./stryker.config.mjs');
  pairFor(name);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

run('npm run compile');
run('stryker run scripts/stryker.config.mjs');

/**
 * @param {string} command
 */
function run(command) {
  const result = spawnSync(command, { stdio: 'inherit', env: process.env, shell: true });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
