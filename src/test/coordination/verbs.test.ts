import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { SHIM_NAMES } from '../../core/paths';
import * as verbs from '../../core/verbs';
import { repoRoot } from '../helpers';

/**
 * The verb bundles the build emitted, as `cli_bundles.test.ts` finds them. The
 * build sweeps a `dist/squadron-*.js` that no longer has an entry, so what is
 * there is what ships.
 */
function bundledVerbs(): string[] {
  const dist = path.join(repoRoot(), 'dist');
  const names = fs.existsSync(dist) ? fs.readdirSync(dist) : [];
  const bundles = names.filter((name) => /^squadron-[a-z-]+\.js$/.test(name));
  assert.ok(bundles.length > 0, 'run npm run compile: no bundles in dist/');
  return bundles.map((name) => name.replace(/\.js$/, ''));
}

const installed = verbs.VERBS.map((v) => `squadron-${v.name}`).sort();

describe('the verb list', () => {
  it('names every verb the installer copies, and nothing else', () => {
    assert.deepEqual(installed, [...SHIM_NAMES].sort());
  });

  it('names every squadron- bundle the build emits, and nothing else', () => {
    assert.deepEqual(installed, bundledVerbs().sort());
  });

  it('reads two verbs and writes with the rest', () => {
    const read = verbs.VERBS.filter((v) => !v.write).map((v) => v.name);
    assert.deepEqual(read, ['list', 'models']);
    assert.ok(verbs.isWriteVerb('end'));
    assert.ok(verbs.isWriteVerb('warm'));
    assert.equal(verbs.VERBS.length, 12);
    assert.ok(!verbs.isWriteVerb('list'));
    assert.ok(!verbs.isWriteVerb('workflow-validation'));
  });

  it('describes each verb in one line', () => {
    for (const v of verbs.VERBS) assert.match(v.what, /^[A-Z][^\n]+\.$/, v.name);
  });
});
