/**
 * What `bufferutil` and `utf-8-validate` resolve to in the host bundle
 * (`esbuild.mjs`). `ws` requires each inside a `try` and takes its JavaScript
 * path when the require throws, so no native add-on can load from anywhere on
 * the reader's disk (root `AGENTS.md`: no native modules, ever).
 */

throw new Error('Squadron bundles no native add-ons');
