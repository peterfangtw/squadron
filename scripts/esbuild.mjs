// The emit half of the build; `tsc` stays the typecheck gate and emits nothing
// for the webview. Run via `node scripts/esbuild.mjs`.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import * as artifacts from './windows-helper-artifacts.mjs';

const helperDefines = {};
for (const helper of artifacts.HELPERS) {
  const manifest = artifacts.prepare(helper, undefined, {
    required:
      !artifacts.stagingBuild(process.cwd()) &&
      (process.argv.includes('--package') || process.env[`${helper.prefix}_REQUIRED`] === '1')
  });
  if (!manifest) console.log(`development JS emission: Windows ${helper.id} helper unavailable`);
  helperDefines[helper.define] = JSON.stringify(manifest?.sha256 ?? null);
}
const helperPin = `"use strict";\nconst __SQUADRON_PRIVATE_FILES_SHA256__ = ${helperDefines.__SQUADRON_PRIVATE_FILES_SHA256__};\nconst __SQUADRON_CONSOLE_LOGIN_SHA256__ = ${helperDefines.__SQUADRON_CONSOLE_LOGIN_SHA256__};`;

// One IIFE, readable on purpose (no minify yet): `document.ts` inlines it into
// the webview's HTML under a nonce CSP, so it must be a bare script — and the
// webview tests assert it stays free of `require(`, `exports` and `</script`.
await build({
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.md': 'text' },
  target: 'es2022',
  outfile: 'out/webview/main.js',
  minify: false,
  sourcemap: false,
  logLevel: 'info'
});

// The host half, bundled to `dist/` so a future runtime dependency ships
// inside the VSIX instead of needing node_modules there. `vscode` is the one
// module only the host can provide. node20 is what vscode ^1.95 runs on.
//
// `mainFields` puts `module` first on purpose: `jsonc-parser`'s `main` is a UMD
// bundle whose wrapper calls `require('./impl/parser')` at load time, and those
// files do not exist beside `dist/extension.js`. esbuild keeps the call as-is,
// so the bundle throws the moment it is required and the extension never
// activates — every command then reads as "not found". The ESM entry has static
// imports esbuild can inline.
//
// `ws` requires two optional native add-ons, each inside a `try`. Both are
// aliased to a module that throws, so `ws` takes its JavaScript path; marked
// `external` instead, Node would resolve a native one from any `node_modules`
// above the install.
const NO_NATIVE = './src/core/slack/no_native.ts';
await build({
  entryPoints: ['src/host/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  mainFields: ['module', 'main'],
  external: ['vscode'],
  alias: { bufferutil: NO_NATIVE, 'utf-8-validate': NO_NATIVE },
  define: helperDefines,
  banner: { js: helperPin },
  outfile: 'dist/extension.js',
  minify: false,
  sourcemap: false,
  logLevel: 'info'
});

// The agent-facing CLIs, bundled for the same reason the host is: the extension
// copies each of these files to `~/.squadron/bin/`, so they must carry
// `core/` with them rather than resolve it from a version-stamped extension
// directory at runtime — that indirection is what broke the feature when the
// emit moved from `out/` to `dist/`.
//
// One build call each rather than two entry points and `outdir`: the banner and
// the flat `dist/` layout are the same either way, and a shared `outdir` would
// put them under `dist/cli/`, which the extension's copy step does not read.
const CLI_NAMES = [
  'squadron-spawn',
  'squadron-end',
  'squadron-rename',
  'squadron-warm',
  'squadron-list',
  'squadron-models',
  'squadron-send',
  'squadron-answer',
  'squadron-wait',
  'squadron-step',
  'squadron-attach',
  'squadron-fetch-file',
  'execution',
  'workflow-validation'
];

// Retired verbs, swept before the writes. esbuild only ever writes, and nothing
// else cleans `dist/` — so a verb whose entry left this list used to leave its
// last build sitting there indefinitely, and `installShim` would go on not
// copying a file that stayed perfectly readable to anything that looked. Worse
// day to day: any checkout whose entry list differs from this one — `main`
// before a rename merges, a bisect, a revert — left a bundle the gate then
// failed on, clearable only by hand (2026-08-26, the End rename).
//
// Swept rather than `rm -rf dist`: `extension.js` and `webview/` are already
// written above, and this is the one directory whose contents the extension
// copies verbatim onto the reader's machine.
const wanted = new Set(CLI_NAMES.map((name) => `${name}.js`));
for (const file of readdirSync('dist')) {
  if (file.startsWith('squadron-') && file.endsWith('.js') && !wanted.has(file)) {
    // `force` and a `try` for the reason `installShim` has both: a tidying
    // delete must not be able to abort the writes below. Bare `rmSync` throws
    // ERR_FS_EISDIR on a directory at that path, and ENOENT when a concurrent
    // build removed the same file between the readdir and here — either one
    // would leave `dist/` with no verb bundles at all.
    try {
      rmSync(`dist/${file}`, { force: true });
      console.log(`  removed dist/${file} — no longer a verb`);
    } catch {
      // Untidy, not broken: nothing below reads it.
    }
  }
}

for (const name of CLI_NAMES) {
  const entry = name === 'squadron-fetch-file' ? 'fetch' : name.replace(/^squadron-/, '');
  await build({
    entryPoints: [`src/cli/${entry}.ts`],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    define: helperDefines,
    banner: { js: `#!/usr/bin/env node\n${helperPin}` },
    outfile: `dist/${name}.js`,
    minify: false,
    sourcemap: false,
    logLevel: 'info'
  });
}

// The packaged extension reads the webview bundle beside `dist/extension.js`;
// the tsc tree keeps its own copy for the tests (see `webviewScript()`).
mkdirSync('dist/webview', { recursive: true });
cpSync('out/webview/main.js', 'dist/webview/main.js');
