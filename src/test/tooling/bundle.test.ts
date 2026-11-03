import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as Module from 'node:module';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { SHIM_NAMES } from '../../core/paths';
import { outRoot, repoRoot } from '../helpers';

/**
 * `dist/extension.js` is the file the IDE actually loads, and until this test
 * nothing in the gate ever required it: the rest of the suite runs against the
 * `out/` tsc tree, where a dependency resolves through node_modules and works
 * whatever esbuild made of it. A bundle that throws on load takes every command
 * with it — the IDE reports `command 'squadron.showOverview' not found`, and
 * the real error lands only in the extension host log.
 */
describe('the compiled extension bundle', () => {
  const file = path.join(repoRoot(), 'dist', 'extension.js');

  it('loads with nothing but `vscode` from outside it', () => {
    // `vscode` is the one module esbuild leaves external, so stand in for the
    // host. Everything else has to be inside the bundle already.
    const loader = Module as unknown as {
      _load(this: void, request: string, parent: unknown, isMain: boolean): unknown;
    };
    const real = loader._load;
    loader._load = (request, parent, isMain) =>
      request === 'vscode' ? {} : real(request, parent, isMain);

    const load = createRequire(__filename);
    try {
      const bundle = load(file) as { activate?: unknown };
      assert.equal(typeof bundle.activate, 'function', 'the bundle must export activate()');
    } finally {
      loader._load = real;
      delete load.cache[load.resolve(file)];
    }
  });

  /**
   * `ws` asks for two optional native add-ons, each inside a `try`.
   * `esbuild.mjs` aliases both to a module that throws, so neither can load
   * from anywhere on the reader's disk. Read off the text, because the load
   * above forwards every `require` to Node and would find either one in this
   * checkout's `node_modules`. The stub's message proves `ws` is in the bundle,
   * so the scan cannot pass for want of it.
   */
  it('holds `ws` with neither native add-on left to require', () => {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /Squadron bundles no native add-ons/);
    assert.doesNotMatch(text, /require\(["']bufferutil["']\)/);
    assert.doesNotMatch(text, /require\(["']utf-8-validate["']\)/);
  });
});

/**
 * A verb has to be spelled the same in four places, and until this only two
 * pairs were ever compared. `SHIM_NAMES` against the skill that documents it is
 * `skill_install.test.ts`. `SHIM_NAMES` against **what esbuild actually emits**
 * was nobody's — and that is the pair with a fortnight-long bug behind it: a
 * verb that reached `src/` and not `dist/` is green in every unit test here and
 * simply missing on the machine, because `installShim` copies `dist/` and
 * nothing else (`session.smoke.ts` tells that story at length).
 *
 * Asserted against the emit rather than against `esbuild.mjs`'s entry array,
 * which would only restate one list against another. The directory knows one
 * thing the array does not: whether the build ran at all.
 *
 * It does not know whether it ran *recently* — a bundle from an older build
 * satisfies both halves on its name alone. Freshness is not this test's job;
 * `npm run check` compiles before it runs anything.
 */
describe('the shipped CLI bundles', () => {
  const dist = path.join(repoRoot(), 'dist');
  const emitted = fs
    .readdirSync(dist)
    .filter((f) => f.startsWith('squadron-') && f.endsWith('.js'))
    .map((f) => f.slice(0, -'.js'.length));

  it('emits one for every verb the installer will copy', () => {
    assert.deepEqual(
      [...SHIM_NAMES].sort(),
      SHIM_NAMES.filter((n) => emitted.includes(n)).sort(),
      'a verb in SHIM_NAMES with no bundle installs as a missing command'
    );
  });

  it('emits no bundle for a verb the installer has retired', () => {
    // The other direction. `esbuild.mjs` now sweeps a retired bundle itself, so
    // in practice this fires on the divergence the pair exists for: an entry
    // list and a `SHIM_NAMES` that disagree about which verbs there are.
    assert.deepEqual(
      emitted.filter((n) => !(SHIM_NAMES as readonly string[]).includes(n)),
      [],
      'esbuild.mjs emitted a bundle SHIM_NAMES does not name, or the reverse'
    );
  });
});

/**
 * The same staleness one tree over, and worse, because this one is *inside the
 * gate*: `npm run check` runs `node --test out/test/*.test.js`, a glob over a
 * directory `tsc` also only ever writes to. A renamed or deleted source leaves
 * its last compiled copy behind, and that copy keeps working — so a stale test
 * goes on passing against an equally stale module, a green nobody wrote and
 * nothing in `src/` backs. Observed on the End rename: `out/test/stop_cli.test.js`
 * reported 28 passing tests against an `out/cli/stop.js` whose source was gone.
 *
 * The whole tree rather than `out/test` alone, which was the first draft and
 * would have caught only half of that pair.
 *
 * The mapping is a path swap because `rootDir` is `src` and `outDir` is `out`.
 * It is *total* for a narrower reason than it looks: `out/webview/main.js` is
 * an esbuild bundle of some forty sources that maps back only because the entry
 * is named `main.ts` and the outfile `main.js`, and `out/webview/skilltext.js`
 * exists because `src/test/skills/skilltext.test.ts` imports it — an import defeats the
 * root project's `exclude`. A second webview entry, or an entry and outfile
 * whose names diverge, breaks totality and shows up here as a false orphan.
 *
 * **The remedy this prints is deliberate and `rm -rf out` alone is not it.**
 * `tsconfig.tsbuildinfo` sits at the repo root, not under `out/`, so a bare
 * `rm -rf out` leaves the buildinfo claiming everything is current: `tsc -b .`
 * then emits nothing, `node --test out/test/*.test.js` matches nothing, and
 * `npm run check` goes green having run **zero tests** (measured 2026-08-26,
 * exit 0). That is a worse phantom green than the one this guard exists for,
 * so the message names the buildinfo too.
 */
describe('the compiled tree', () => {
  const out = outRoot();
  const src = path.join(repoRoot(), 'src');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : e.name.endsWith('.js') ? [full] : [];
    });

  it('holds no module whose source is gone', () => {
    const orphans = walk(out)
      .map((f) => path.relative(out, f).slice(0, -'.js'.length))
      .filter((rel) => !fs.existsSync(path.join(src, `${rel}.ts`)))
      .sort();
    assert.deepEqual(
      orphans,
      [],
      'stale compiled output — run `npx tsc -b . --force`, or delete BOTH out/ and tsconfig.tsbuildinfo'
    );
  });
});
