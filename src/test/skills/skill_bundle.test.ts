import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as skillInstall from '../../core/skill_install';
import * as workflows from '../../core/workflows/workflows';
import { linkDir, needsFileSymlinks, repoRoot } from '../helpers';

const sourceDir = path.join(repoRoot(), 'install', 'skills');
const builderDir = 'squadron-workflow-builder';
const version = '2026.40.1';
let root: string;
let home: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-skill-bundle-'));
});
after(() => fs.rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(root, 'home-'));
  for (const cli of ['.claude', '.grok', '.codex']) await fs.mkdir(path.join(home, cli));
});

describe('bundled skills', () => {
  it('installs every skill and its references for each CLI, then leaves them current', async () => {
    for (const cli of ['.claude', '.grok', '.codex']) {
      const results = await skillInstall.installBundledSkills(sourceDir, version, cli, home);
      assert.equal(results.length, skillInstall.SKILL_FILES.length);
      for (const asset of skillInstall.SKILL_FILES) {
        const { file } = skillInstall.skillPaths(cli, home, asset);
        assert.equal(results.find((result) => result.file === file)?.outcome, 'written');
        const shipped = await fs.readFile(path.join(sourceDir, asset.skill, asset.name), 'utf8');
        const installed = await fs.readFile(file, 'utf8');
        const format = asset.name.endsWith('.yaml') ? 'yaml' : 'markdown';
        const stamp = skillInstall.readInstalledText(installed);
        assert.equal(stamp.kind, 'ours');
        assert.ok(stamp.kind === 'ours');
        assert.match(stamp.bundleHash ?? '', /^[0-9a-f]{64}$/);
        assert.equal(
          installed,
          `${shipped}${skillInstall.stampLine(shipped, version, format, stamp.bundleHash)}\n`
        );
      }
      const again = await skillInstall.installBundledSkills(sourceDir, version, cli, home);
      assert.ok(again.every((result) => result.outcome === 'current'));
    }
  });

  it('upgrades owned references while preserving an edited one', async () => {
    await skillInstall.installBundledSkills(sourceDir, version, '.codex', home);
    const directory = path.join(home, '.codex', 'skills', builderDir);
    const older = 'An older reference.\n';
    await fs.writeFile(
      path.join(directory, 'FORMAT.md'),
      `${older}${skillInstall.stampLine(older, '2026.39.1')}\n`
    );
    const edited = `${await fs.readFile(path.join(directory, 'LANES.md'), 'utf8')}My edits.\n`;
    await fs.writeFile(path.join(directory, 'LANES.md'), edited);

    const results = await skillInstall.installBundledSkills(sourceDir, version, '.codex', home);
    assert.equal(
      results.find((result) => path.basename(result.file) === 'FORMAT.md')?.outcome,
      'written'
    );
    assert.equal(
      results.find((result) => path.basename(result.file) === 'LANES.md')?.outcome,
      'left-foreign'
    );
    assert.equal(await fs.readFile(path.join(directory, 'LANES.md'), 'utf8'), edited);
  });

  it('leaves a foreign builder and its references alone while installing the CLI skill', async () => {
    const directory = path.join(home, '.codex', 'skills', builderDir);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'SKILL.md'), 'My builder.\n');
    const results = await skillInstall.installBundledSkills(sourceDir, version, '.codex', home);
    assert.equal(results[0]?.outcome, 'written');
    assert.equal(
      results.find((result) => result.file === path.join(directory, 'SKILL.md'))?.outcome,
      'left-foreign'
    );
    assert.equal(results.length, skillInstall.SKILL_FILES.length - 3);
    assert.equal(await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8'), 'My builder.\n');
    assert.deepEqual(await fs.readdir(directory), ['SKILL.md']);
  });

  it('leaves references beside a newer builder untouched', async () => {
    const directory = path.join(home, '.codex', 'skills', builderDir);
    await fs.mkdir(directory, { recursive: true });
    const newer = 'A newer builder.\n';
    await fs.writeFile(
      path.join(directory, 'SKILL.md'),
      `${newer}${skillInstall.stampLine(newer, '2026.41.1')}\n`
    );
    const results = await skillInstall.installBundledSkills(sourceDir, version, '.codex', home);
    assert.equal(
      results.find((result) => result.file === path.join(directory, 'SKILL.md'))?.outcome,
      'left-newer'
    );
    assert.deepEqual(await fs.readdir(directory), ['SKILL.md']);
  });

  it('preserves a linked reference and its target', { skip: needsFileSymlinks() }, async () => {
    const directory = path.join(home, '.codex', 'skills', builderDir);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(home, 'my-format.md');
    await fs.writeFile(target, 'My format.\n');
    await fs.symlink(target, path.join(directory, 'FORMAT.md'));
    const results = await skillInstall.installBundledSkills(sourceDir, version, '.codex', home);
    assert.equal(
      results.find((result) => path.basename(result.file) === 'FORMAT.md')?.outcome,
      'unsafe-path'
    );
    assert.ok((await fs.lstat(path.join(directory, 'FORMAT.md'))).isSymbolicLink());
    assert.equal(await fs.readFile(target, 'utf8'), 'My format.\n');
    assert.equal(
      skillInstall.readInstalledText(await fs.readFile(path.join(directory, 'LANES.md'), 'utf8'))
        .kind,
      'ours'
    );
  });

  it('leaves a linked builder directory alone', async () => {
    const outside = path.join(home, 'my-builder');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'SKILL.md'), 'My builder.\n');
    await fs.mkdir(path.join(home, '.codex', 'skills'));
    await linkDir(outside, path.join(home, '.codex', 'skills', builderDir));
    const results = await skillInstall.installBundledSkills(sourceDir, version, '.codex', home);
    assert.equal(
      results.find(
        (result) => result.file === path.join(home, '.codex', 'skills', builderDir, 'SKILL.md')
      )?.outcome,
      'unsafe-path'
    );
    assert.deepEqual(await fs.readdir(outside), ['SKILL.md']);
    assert.equal(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8'), 'My builder.\n');
  });

  it('ships runnable examples in the builder references', async () => {
    for (const name of ['FORMAT.md', 'LANES.md']) {
      const text = await fs.readFile(path.join(sourceDir, builderDir, name), 'utf8');
      const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)];
      assert.ok(examples.length > 0);
      for (const example of examples) {
        const workflow: unknown = JSON.parse(example[1] ?? '');
        assert.deepEqual(workflows.validate(workflow), []);
        assert.deepEqual(await workflows.armable(workflow as workflows.Workflow, home), []);
      }
    }
  });
});
