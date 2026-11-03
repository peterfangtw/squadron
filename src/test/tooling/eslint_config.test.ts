import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';
import { repoRoot } from '../helpers';

const ROOT = repoRoot();
const lint = new ESLint({ cwd: ROOT });

describe('ESLint file and runtime boundaries', () => {
  it('ignores scratch files at any depth while retaining maintained scripts', async () => {
    for (const file of [
      'probe.tmp.mjs',
      '.probe.mjs',
      'probe.tmp/run.mjs',
      'docs/mockups/probe.tmp.mjs',
      'docs/mockups/.probe.mjs',
      'docs/mockups/probe.tmp/run.mjs'
    ]) {
      assert.equal(await lint.isPathIgnored(path.join(ROOT, file)), true, file);
    }
    for (const file of ['scripts/esbuild.mjs', 'docs/mockups/build-at-mention.mjs']) {
      assert.equal(await lint.isPathIgnored(path.join(ROOT, file)), false, file);
    }
  });

  it('allows browser globals only in tools that execute page code', async () => {
    const browser = 'void document; void Image; void getComputedStyle; void dispatchEvent;';
    const [node] = await lint.lintText(browser + ' void URL; void MessageEvent;', {
      filePath: path.join(ROOT, 'scripts/esbuild.mjs')
    });
    assert.equal(node?.errorCount, 4);
    assert.ok(node?.messages.every((message) => message.ruleId === 'no-undef'));

    for (const file of [
      'docs/mockups/build-at-mention.mjs',
      'docs/mockups/coffee-cup/shoot-pour.mjs',
      'docs/design_tokens/build-color-balance.mjs'
    ]) {
      const [page] = await lint.lintText(browser, { filePath: path.join(ROOT, file) });
      assert.deepEqual(page?.messages, [], file);
    }
  });
});
