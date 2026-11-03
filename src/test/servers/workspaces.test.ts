import * as assert from 'node:assert/strict';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, it } from 'node:test';
import { declaresWorkspaces, projectDirs } from '../../core/devservers/workspaces';

/**
 * The fixtures here are what was read off this machine on 2026-08-04, not what a
 * workspace manifest ought to look like. The t3code case in particular is a
 * regression test with a name: its `pnpm-workspace.yaml` carries eight keys
 * beside `packages:`, several with `- ` lines of their own, and the obvious
 * parse — "collect every line starting with `- `" — returns
 * `browser-tabs-lock: false` and `"@clerk/backend@3.13.0"` as directories.
 */

let tree: string;

beforeEach(async () => {
  tree = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-ws-'));
});

/** A directory with a manifest in it — which is what makes it a project. */
async function project(rel: string): Promise<string> {
  const dir = path.join(tree, rel);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(rel) }));
  return dir;
}

/** A directory matching a glob with no manifest — `apps/scratch`, observed. */
async function bare(rel: string): Promise<void> {
  await fs.mkdir(path.join(tree, rel), { recursive: true });
}

const pnpm = (body: string) => fs.writeFile(path.join(tree, 'pnpm-workspace.yaml'), body);

describe('declaresWorkspaces', () => {
  it('reads the npm array form', () => {
    assert.equal(declaresWorkspaces({ workspaces: ['apps/*'] }, false), true);
  });

  it('reads the object form', () => {
    assert.equal(declaresWorkspaces({ workspaces: { packages: ['apps/*'] } }, false), true);
  });

  it('takes the pnpm file as declaration enough', () => {
    assert.equal(declaresWorkspaces({}, true), true);
    assert.equal(declaresWorkspaces(undefined, true), true);
  });

  it('says no for a plain repo, and for an empty declaration', () => {
    assert.equal(declaresWorkspaces({ scripts: { dev: 'vite' } }, false), false);
    assert.equal(declaresWorkspaces({ workspaces: [] }, false), false);
    assert.equal(declaresWorkspaces({ workspaces: { packages: [] } }, false), false);
    assert.equal(declaresWorkspaces(undefined, false), false);
  });
});

describe('projectDirs', () => {
  it('is the tree alone when nothing is declared', async () => {
    assert.deepEqual(await projectDirs(tree, { scripts: { dev: 'vite' } }), [tree]);
    assert.deepEqual(await projectDirs(tree, undefined), [tree]);
  });

  it('expands the npm array form, root first', async () => {
    const store = await project('apps/store');
    const admin = await project('apps/admin');
    const ui = await project('packages/ui');

    assert.deepEqual(await projectDirs(tree, { workspaces: ['apps/*', 'packages/*'] }), [
      tree,
      admin,
      store,
      ui
    ]);
  });

  it('expands the object form the same way', async () => {
    const store = await project('apps/store');
    assert.deepEqual(await projectDirs(tree, { workspaces: { packages: ['apps/*'] } }), [
      tree,
      store
    ]);
  });

  it('takes a literal path as well as a glob', async () => {
    const scripts = await project('scripts');
    assert.deepEqual(await projectDirs(tree, { workspaces: ['scripts'] }), [tree, scripts]);
  });

  it('leaves out a glob match with no package.json', async () => {
    const store = await project('apps/store');
    await bare('apps/scratch');
    await bare('apps/site-astro');

    assert.deepEqual(await projectDirs(tree, { workspaces: ['apps/*'] }), [tree, store]);
  });

  it('reads the pnpm packages block', async () => {
    const store = await project('apps/store');
    const ui = await project('packages/ui');
    await pnpm(['packages:', "  - 'apps/*'", '  - "packages/*"', ''].join('\n'));

    assert.deepEqual(await projectDirs(tree, {}), [tree, store, ui]);
  });

  it('reads a pnpm file that starts with a BOM', async () => {
    // JS `\s` includes U+FEFF, so an unstripped BOM makes `packages:` read as an
    // indented line and the block never opens.
    const store = await project('apps/store');
    await pnpm('\uFEFFpackages:\n  - apps/*\n');

    assert.deepEqual(await projectDirs(tree, {}), [tree, store]);
  });

  it('reads a pnpm sequence written at column 0', async () => {
    // Valid YAML and pnpm reads it. Treating the dashes as keys ended the block
    // on its own first entry and dropped the whole list.
    const store = await project('apps/store');
    const ui = await project('packages/ui');
    await pnpm(['packages:', "- 'apps/*'", '- "packages/*"'].join('\n'));

    assert.deepEqual(await projectDirs(tree, {}), [tree, store, ui]);
  });

  it('still stops a column-0 sequence at the next key', async () => {
    const store = await project('apps/store');
    await project('browser-tabs-lock');
    await pnpm(['packages:', "- 'apps/*'", 'allowBuilds:', '- browser-tabs-lock'].join('\n'));

    assert.deepEqual(await projectDirs(tree, {}), [tree, store]);
  });

  it('stops the pnpm block at the next column-0 key', async () => {
    const store = await project('apps/store');
    // Directories named after the entries the other blocks carry, so a leak is
    // an assertion failure rather than a silent absence. t3code's entry ends
    // `: false`, dropped here because win32 forbids `:` in a file name.
    await project('browser-tabs-lock');
    await project('@clerk/backend@3.13.0');
    await pnpm(
      [
        '# the t3code shape, read 2026-08-04',
        'packages:',
        "  - 'apps/*'",
        '',
        'allowBuilds:',
        '  - browser-tabs-lock',
        'overrides:',
        '  - "@clerk/backend@3.13.0"',
        'catalog:',
        '  react: 19.2.0'
      ].join('\n')
    );

    assert.deepEqual(await projectDirs(tree, {}), [tree, store]);
  });

  it('drops a negation rather than treating it as a directory', async () => {
    const store = await project('apps/store');
    await project('!apps/private');
    await pnpm(['packages:', '  - apps/*', '  - "!apps/private"'].join('\n'));

    assert.deepEqual(await projectDirs(tree, {}), [tree, store]);
  });

  it('drops a mid-segment star rather than widening it', async () => {
    await project('packages/ui-web');
    await project('packages/ui-native');

    assert.deepEqual(await projectDirs(tree, { workspaces: ['packages/*-web'] }), [tree]);
  });

  it('drops a pattern that climbs out of the tree', async () => {
    await project('apps/store');
    assert.deepEqual(await projectDirs(tree, { workspaces: ['../*', '/etc'] }), [tree]);
  });

  it('never returns node_modules or a dot directory', async () => {
    const store = await project('apps/store');
    await project('node_modules/left-pad');
    await project('.cache/thing');

    // `**` from the tree root is the widest thing this reads, so it is what the
    // two skips have to survive.
    assert.deepEqual(await projectDirs(tree, { workspaces: ['**'] }), [tree, store]);
  });

  it('treats a malformed or unreadable manifest as no workspaces', async () => {
    await project('apps/store');
    await pnpm('packages\n\t- apps/*\n');

    assert.deepEqual(await projectDirs(tree, {}), [tree]);
  });

  it('takes both manifests when a repo carries both', async () => {
    const store = await project('apps/store');
    const ui = await project('packages/ui');
    await pnpm(['packages:', '  - packages/*'].join('\n'));

    assert.deepEqual(await projectDirs(tree, { workspaces: ['apps/*'] }), [tree, store, ui]);
  });

  it('does not descend past two levels below the tree', async () => {
    await project('apps/store/nested');
    const store = await project('apps/store');

    assert.deepEqual(await projectDirs(tree, { workspaces: ['apps/**'] }), [tree, store]);
  });
});
