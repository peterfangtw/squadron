import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';

type Themes = typeof import('../../core/repo_theme');
let themes: Themes;
const dir = () => path.join(home, '.squadron', 'themes');
let home: string;

const folderA = path.resolve('/work', 'agentsview');
const folderB = path.resolve('/work', 'other');

before(async () => {
  home = await tempHome();
  themes = await import('../../core/repo_theme');
});

async function reset(): Promise<void> {
  await fs.rm(dir(), { recursive: true, force: true });
}

describe('a folder theme', () => {
  it('uses the shared setting until the folder has chosen, and keeps follow as a choice', async () => {
    await reset();
    assert.equal(await themes.readRepoTheme(folderA), undefined);
    assert.equal(themes.effectiveTheme(undefined, 'ink'), 'ink');
    assert.equal(themes.effectiveTheme(undefined, 'nope'), 'follow');
    assert.equal(await themes.writeRepoTheme(folderA, 'follow'), true);
    assert.equal(await themes.readRepoTheme(folderA), 'follow');
    assert.equal(themes.effectiveTheme(await themes.readRepoTheme(folderA), 'ink'), 'follow');
  });

  it('keeps each folder its own theme', async () => {
    await reset();
    assert.equal(await themes.writeRepoTheme(folderA, 'paper'), true);
    assert.equal(await themes.writeRepoTheme(folderB, 'malachite'), true);
    assert.equal(await themes.readRepoTheme(folderA), 'paper');
    assert.equal(await themes.readRepoTheme(folderB), 'malachite');
    assert.equal(await themes.writeRepoTheme(folderA, 'neon'), true);
    assert.equal(await themes.readRepoTheme(folderA), 'neon');
    assert.equal(await themes.readRepoTheme(folderB), 'malachite');
  });

  it('ignores a file that is not this folder’s theme', async () => {
    await reset();
    assert.equal(await themes.writeRepoTheme(folderA, 'ink'), true);
    const [name] = await fs.readdir(dir());
    assert.ok(name);
    const file = path.join(dir(), name);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { folder: string; theme: string };
    raw.folder = folderB;
    await fs.writeFile(file, JSON.stringify(raw));
    assert.equal(await themes.readRepoTheme(folderA), undefined);
    raw.folder = folderA;
    raw.theme = 'nope';
    await fs.writeFile(file, JSON.stringify({ ...raw, schema: 1 }));
    assert.equal(await themes.readRepoTheme(folderA), undefined);
    await fs.writeFile(file, JSON.stringify({ schema: 2, folder: folderA, theme: 'ink' }));
    assert.equal(await themes.readRepoTheme(folderA), undefined);
  });

  it('refuses an empty folder', async () => {
    await reset();
    assert.equal(await themes.writeRepoTheme('', 'ink'), false);
    assert.equal(await themes.readRepoTheme(''), undefined);
    assert.deepEqual(await fs.readdir(dir()).catch(() => []), []);
  });
});
