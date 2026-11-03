import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import * as skillInstall from '../../core/skill_install';
import { linkDir, repoRoot } from '../helpers';

const metadata = { skill: 'squadron', name: 'agents/openai.yaml' } as const;
const shipped = path.join(repoRoot(), 'install', 'skills');
let root: string;
let home: string;
let source: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-skill-metadata-'));
  source = path.join(shipped, metadata.skill, metadata.name);
});
after(() => fs.rm(root, { recursive: true, force: true }));
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(root, 'home-'));
  await fs.mkdir(path.join(home, '.codex'));
});

describe('skill invocation metadata', () => {
  it('installs policy as YAML and upgrades an owned copy', async () => {
    assert.equal(
      await skillInstall.installSkill(source, '0.3.2', '.codex', home, metadata),
      'written'
    );
    const { file } = skillInstall.skillPaths('.codex', home, metadata);
    const body = await fs.readFile(source, 'utf8');
    const installed = await fs.readFile(file, 'utf8');
    assert.equal(installed, `${body}${skillInstall.stampLine(body, '0.3.2', 'yaml')}\n`);
    assert.equal(skillInstall.readInstalledText(installed).kind, 'ours');
    assert.equal(
      await skillInstall.installSkill(source, '0.3.2', '.codex', home, metadata),
      'current'
    );

    const explicitOnly = body.replace(
      'allow_implicit_invocation: true',
      'allow_implicit_invocation: false'
    );
    assert.notEqual(explicitOnly, body);
    const nextSource = path.join(home, 'next.yaml');
    await fs.writeFile(nextSource, explicitOnly);
    assert.equal(
      await skillInstall.installSkill(nextSource, '0.3.3', '.codex', home, metadata),
      'written'
    );
    assert.equal(
      await fs.readFile(file, 'utf8'),
      `${explicitOnly}${skillInstall.stampLine(explicitOnly, '0.3.3', 'yaml')}\n`
    );
  });

  it('keeps a user-edited invocation policy on upgrade', async () => {
    await skillInstall.installSkill(source, '0.3.2', '.codex', home, metadata);
    const { file } = skillInstall.skillPaths('.codex', home, metadata);
    const installed = await fs.readFile(file, 'utf8');
    const edited = installed.replace(
      'allow_implicit_invocation: true',
      'allow_implicit_invocation: false'
    );
    assert.notEqual(edited, installed);
    await fs.writeFile(file, edited);
    assert.equal(
      await skillInstall.installSkill(source, '0.3.3', '.codex', home, metadata),
      'left-foreign'
    );
    assert.equal(await fs.readFile(file, 'utf8'), edited);
  });

  it('leaves metadata beside a foreign entrypoint alone', async () => {
    const { dir, file } = skillInstall.skillPaths('.codex', home, metadata);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'My Squadron skill.\n');
    const results = await skillInstall.installBundledSkills(shipped, '0.3.2', '.codex', home);
    assert.equal(
      results.find((result) => result.file === file),
      undefined
    );
    assert.deepEqual(await fs.readdir(dir), ['SKILL.md']);
  });

  it('leaves missing metadata beside a newer identical entrypoint alone', async () => {
    const { dir, file } = skillInstall.skillPaths('.codex', home, metadata);
    const body = await fs.readFile(path.join(shipped, metadata.skill, 'SKILL.md'), 'utf8');
    await fs.mkdir(dir, { recursive: true });
    const newer = `${body}${skillInstall.stampLine(body, '0.3.3')}\n`;
    await fs.writeFile(path.join(dir, 'SKILL.md'), newer);

    const results = await skillInstall.installBundledSkills(shipped, '0.3.2', '.codex', home);
    assert.equal(results[0]?.outcome, 'left-newer');
    assert.equal(
      results.find((result) => result.file === file),
      undefined
    );
    assert.deepEqual(await fs.readdir(dir), ['SKILL.md']);
    assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), newer);
  });

  it('migrates legacy stamps and refreshes versions even with unchanged content', async () => {
    const entrypointSource = path.join(shipped, metadata.skill, 'SKILL.md');
    await skillInstall.installSkill(entrypointSource, '0.3.2', '.codex', home);
    await skillInstall.installSkill(source, '0.3.2', '.codex', home, metadata);
    const migrated = await skillInstall.installBundledSkills(shipped, '0.3.2', '.codex', home);
    assert.ok(migrated.every((result) => result.outcome === 'written'));

    const upgraded = await skillInstall.installBundledSkills(shipped, '0.3.3', '.codex', home);
    assert.ok(upgraded.every((result) => result.outcome === 'written'));
    for (const result of upgraded) {
      const stamp = skillInstall.readInstalledText(await fs.readFile(result.file, 'utf8'));
      assert.ok(stamp.kind === 'ours');
      assert.deepEqual(stamp.version, [0, 3, 3]);
      assert.match(stamp.bundleHash ?? '', /^[0-9a-f]{64}$/);
    }
    const older = await skillInstall.installBundledSkills(shipped, '0.3.2', '.codex', home);
    assert.ok(older.every((result) => result.outcome === 'left-newer'));
  });

  it('keeps mirrored policies together across same-version activations in either order', async () => {
    const variants: string[] = [];
    for (const disabled of ['false', 'true']) {
      const variant = await fs.mkdtemp(path.join(root, 'variant-'));
      await fs.cp(shipped, variant, { recursive: true });
      await fs.writeFile(
        path.join(variant, metadata.skill, 'SKILL.md'),
        `---\nname: squadron\ndescription: Coordinate sessions.\nuser-invocable: true\ndisable-model-invocation: ${disabled}\n---\nName your session.\n`
      );
      await fs.writeFile(
        path.join(variant, metadata.skill, metadata.name),
        `policy:\n  allow_implicit_invocation: ${disabled === 'false' ? 'true' : 'false'}\n`
      );
      variants.push(variant);
    }
    // These fixtures have opposite Markdown/YAML hash winners; independent ties mix them.
    const installedPolicies: string[] = [];
    for (const order of [variants, [...variants].reverse()]) {
      const cliHome = await fs.mkdtemp(path.join(root, 'tie-home-'));
      await fs.mkdir(path.join(cliHome, '.codex'));
      for (const variant of [...order, ...order])
        await skillInstall.installBundledSkills(variant, '0.3.2', '.codex', cliHome);
      const { dir, file } = skillInstall.skillPaths('.codex', cliHome, metadata);
      const entrypoint = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
      const disabled = /disable-model-invocation: (true|false)/.exec(entrypoint)?.[1];
      assert.ok(disabled);
      const policy = await fs.readFile(file, 'utf8');
      assert.match(
        policy,
        new RegExp(`allow_implicit_invocation: ${disabled === 'true' ? 'false' : 'true'}`)
      );
      installedPolicies.push(policy);
    }
    assert.equal(installedPolicies[0], installedPolicies[1]);
  });

  it('converges across same-version bundles when only metadata changes', async () => {
    const variant = await fs.mkdtemp(path.join(root, 'metadata-only-'));
    await fs.cp(shipped, variant, { recursive: true });
    const variantPolicy = path.join(variant, metadata.skill, metadata.name);
    await fs.appendFile(variantPolicy, '# Another build.\n');
    const installedPolicies: string[] = [];
    for (const order of [
      [shipped, variant],
      [variant, shipped]
    ]) {
      const cliHome = await fs.mkdtemp(path.join(root, 'metadata-home-'));
      await fs.mkdir(path.join(cliHome, '.codex'));
      for (const sourceDir of [...order, ...order])
        await skillInstall.installBundledSkills(sourceDir, '0.3.2', '.codex', cliHome);
      const { dir, file } = skillInstall.skillPaths('.codex', cliHome, metadata);
      const entrypoint = skillInstall.readInstalledText(
        await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')
      );
      const policy = await fs.readFile(file, 'utf8');
      const stamp = skillInstall.readInstalledText(policy);
      assert.ok(entrypoint.kind === 'ours' && stamp.kind === 'ours');
      assert.equal(entrypoint.bundleHash, stamp.bundleHash);
      installedPolicies.push(policy);
    }
    assert.equal(installedPolicies[0], installedPolicies[1]);
  });

  it('installs the source snapshot used for its bundle revision', async (t) => {
    const variant = await fs.mkdtemp(path.join(root, 'snapshot-'));
    await fs.cp(shipped, variant, { recursive: true });
    const entrypointSource = path.join(variant, metadata.skill, 'SKILL.md');
    const originalBody = await fs.readFile(entrypointSource, 'utf8');
    const readFile = fs.readFile;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      const body = await readFile(...args);
      if (args[0] === entrypointSource)
        await fs.appendFile(entrypointSource, 'Changed after capture.\n');
      return body;
    });

    await skillInstall.installBundledSkills(variant, '0.3.2', '.codex', home);
    const { dir } = skillInstall.skillPaths('.codex', home, metadata);
    const installed = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
    const stamp = skillInstall.readInstalledText(installed);
    assert.ok(stamp.kind === 'ours');
    assert.equal(
      installed,
      `${originalBody}${skillInstall.stampLine(originalBody, '0.3.2', 'markdown', stamp.bundleHash)}\n`
    );
    assert.match(await readFile(entrypointSource, 'utf8'), /Changed after capture/);
  });

  it('preserves foreign backup names while sweeping a crashed metadata write', async () => {
    await skillInstall.installSkill(source, '0.3.2', '.codex', home, metadata);
    const { file } = skillInstall.skillPaths('.codex', home, metadata);
    const backup = `${file}.backup.tmp`;
    const backupDirectory = `${file}.backup-dir.tmp`;
    const stale = `${file}.999999.0.tmp`;
    await fs.writeFile(backup, 'My policy backup.\n');
    await fs.mkdir(backupDirectory);
    await fs.writeFile(path.join(backupDirectory, 'policy.yaml'), 'My other policy.\n');
    await fs.writeFile(stale, 'Unfinished installer write.\n');

    assert.equal(
      await skillInstall.installSkill(source, '0.3.2', '.codex', home, metadata),
      'current'
    );
    assert.equal(await fs.readFile(backup, 'utf8'), 'My policy backup.\n');
    assert.equal(
      await fs.readFile(path.join(backupDirectory, 'policy.yaml'), 'utf8'),
      'My other policy.\n'
    );
    await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  });

  it('refuses a linked agents directory without changing its policy', async () => {
    const { dir } = skillInstall.skillPaths('.codex', home, metadata);
    const outside = path.join(home, 'my-agents');
    const policy = 'policy:\n  allow_implicit_invocation: false\n';
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'openai.yaml'), policy);
    await fs.mkdir(dir, { recursive: true });
    await linkDir(outside, path.join(dir, 'agents'));
    assert.equal(
      await skillInstall.installSkill(source, '0.3.2', '.codex', home, metadata),
      'unsafe-path'
    );
    assert.deepEqual(await fs.readdir(outside), ['openai.yaml']);
    assert.equal(await fs.readFile(path.join(outside, 'openai.yaml'), 'utf8'), policy);
  });
});
