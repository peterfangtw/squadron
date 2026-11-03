import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome, linkDir } from '../helpers';
import { withWin32Paths } from '../win32_paths';

let home: string;
let skills: typeof import('../../core/skills');
let adapter: typeof import('../../core/adapter');
before(async () => {
  home = await tempHome();
  skills = await import('../../core/skills');
  adapter = await import('../../core/adapter');
});

async function skill(root: string, folder: string, name = folder, body?: string): Promise<void> {
  const dir = path.join(root, 'skills', folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    body ?? `---\nname: ${name}\ndescription: Fixture\n---\n`
  );
}

function discovery(
  base: string,
  env: NodeJS.ProcessEnv = {}
): InstanceType<typeof skills.SkillDiscovery> {
  return new skills.SkillDiscovery(
    (['claude', 'codex', 'grok'] as const).map((brand) => adapter.adapter(brand)!),
    base,
    env
  );
}

describe('folder skill discovery', () => {
  it('keeps Windows case-distinct and cross-root cwds outside project skills', async (t) => {
    const source = path.join(home, 'lexical-source');
    await skill(source, 'project-only');
    const realpath = fs.realpath;
    t.mock.method(fs, 'realpath', (directory: Parameters<typeof fs.realpath>[0]) =>
      typeof directory === 'string' && /^[A-Za-z]:|^[\\/]{2}/.test(directory)
        ? Promise.resolve(directory)
        : realpath(directory)
    );
    const catalog = new skills.SkillDiscovery(
      [
        {
          brand: 'codex',
          skillSources: (_home, _env, cwd) =>
            cwd ? [{ directory: path.join(source, 'skills') }] : []
        }
      ],
      home,
      {}
    );
    await withWin32Paths(async () => {
      await catalog.setWorkspaces(['C:\\x\\Foo']);
      assert.deepEqual((await catalog.forCwd('c:/x/Foo/child')).codex, ['project-only']);
      for (const cwd of [
        'C:\\x\\foo\\child',
        'D:\\x\\Foo\\child',
        '\\\\srv\\b\\child',
        'C:\\x\\Foo\\..\\other',
        'C:\\x\\Foo2\\child'
      ])
        assert.deepEqual((await catalog.forCwd(cwd)).codex, [], cwd);
      await catalog.setWorkspaces(['\\\\srv\\a']);
      assert.deepEqual((await catalog.forCwd('//srv/a/child')).codex, ['project-only']);
      assert.deepEqual((await catalog.forCwd('\\\\srv\\b\\child')).codex, []);
    });
    catalog.dispose();
  });

  it('discovers private/shared global and project names before any session exists', async () => {
    const base = path.join(home, 'first');
    const repo = path.join(base, 'repo');
    for (const root of [base, repo]) {
      for (const cli of ['claude', 'codex', 'grok', 'agents']) {
        await skill(path.join(root, `.${cli}`), `${root === repo ? 'project' : 'global'}-${cli}`);
      }
    }
    const catalog = discovery(base);
    await catalog.setWorkspaces([repo]);
    const names = await catalog.forCwd(repo);
    assert.deepEqual(names.claude, ['global-claude', 'project-claude']);
    assert.deepEqual(names.codex, [
      'global-agents',
      'global-codex',
      'project-agents',
      'project-codex'
    ]);
    assert.deepEqual(names.grok, [
      'global-agents',
      'global-claude',
      'global-grok',
      'project-agents',
      'project-claude',
      'project-grok'
    ]);
    assert.deepEqual((await catalog.forCwd(base)).claude, ['global-claude']);
  });

  it('honors custom configuration roots without consulting binary paths', async () => {
    const base = path.join(home, 'custom');
    const env: NodeJS.ProcessEnv = {};
    for (const [cli, variable] of [
      ['claude', 'CLAUDE_CONFIG_DIR'],
      ['codex', 'CODEX_HOME'],
      ['grok', 'GROK_HOME']
    ] as const) {
      await skill(path.join(base, `.${cli}`), `default-${cli}`);
      const custom = path.join(base, `custom-${cli}`);
      env[variable] = custom;
      await skill(custom, `custom-${cli}`);
    }
    await skill(path.join(base, '.agents'), 'shared');
    const catalog = discovery(base, env);
    await catalog.setWorkspaces([]);
    const names = await catalog.forCwd(base);
    assert.deepEqual(names.claude, ['custom-claude']);
    assert.deepEqual(names.codex, ['custom-codex', 'shared']);
    assert.deepEqual(names.grok, ['custom-grok', 'default-claude', 'shared']);
  });

  it('includes Grok bundled skills under its configured home and Claude commands', async () => {
    const base = path.join(home, 'grok-bundled');
    const custom = path.join(base, 'private');
    await skill(path.join(custom, 'bundled'), 'bundled-marker');
    await skill(path.join(base, '.grok', 'bundled'), 'old-bundled');
    const commands = path.join(base, '.claude', 'commands');
    await fs.mkdir(commands, { recursive: true });
    await fs.writeFile(path.join(commands, 'compat-command.md'), '# command');
    const catalog = discovery(base, { GROK_HOME: custom });
    const names = await catalog.forCwd(base);
    assert.deepEqual(names.grok, ['bundled-marker', 'compat-command']);
    assert.deepEqual(names.codex, []);
  });

  it('names the same command by path for Claude and metadata for Grok', async () => {
    const base = path.join(home, 'command-names');
    const commands = path.join(base, '.claude', 'commands');
    await fs.mkdir(commands, { recursive: true });
    await fs.writeFile(
      path.join(commands, 'path-name.md'),
      '---\nname: metadata-name\ndescription: marker\n---\nCommand.\n'
    );
    const names = await discovery(base).forCwd(base);
    assert.deepEqual(names.claude, ['path-name']);
    assert.deepEqual(names.grok, ['metadata-name']);
  });

  it('uses the deepest canonical opened root and removes only that root contribution', async () => {
    const base = path.join(home, 'scope');
    const repo = path.join(base, 'worktree');
    const nested = path.join(repo, 'nested');
    const other = path.join(base, 'other');
    await skill(path.join(base, '.agents'), 'shared');
    await skill(path.join(repo, '.codex'), 'outer');
    await skill(path.join(nested, '.codex'), 'inner');
    await skill(path.join(other, '.codex'), 'other');
    const alias = path.join(base, 'alias');
    await linkDir(repo, alias);
    const catalog = discovery(base);
    await catalog.setWorkspaces([alias, nested, other]);
    assert.deepEqual((await catalog.forCwd(nested)).codex, ['inner', 'shared']);
    assert.deepEqual((await catalog.forCwd(alias)).codex, ['outer', 'shared']);
    assert.deepEqual((await catalog.forCwd(path.join(base, 'worktree-other'))).codex, ['shared']);
    assert.deepEqual(catalog.union(), ['inner', 'other', 'outer', 'shared']);
    assert.deepEqual(await catalog.forSession({ cwd: repo, liveCwd: other, brand: 'codex' }), [
      'other',
      'shared'
    ]);
    assert.deepEqual(await catalog.forSession({ cwd: repo, liveCwd: base, brand: 'codex' }), [
      'shared'
    ]);
    await catalog.setWorkspaces([other]);
    assert.deepEqual((await catalog.forCwd(repo)).codex, ['shared']);
    assert.deepEqual((await catalog.forCwd(other)).codex, ['other', 'shared']);
  });

  it('does not publish an old project scan after removal or disposal', async () => {
    const base = path.join(home, 'late');
    const repo = path.join(base, 'repo');
    await skill(path.join(repo, '.claude'), 'project-only');
    const catalog = discovery(base);
    await catalog.setWorkspaces([]);
    const adding = catalog.setWorkspaces([repo]);
    await catalog.setWorkspaces([]);
    await adding;
    assert.deepEqual((await catalog.forCwd(repo)).claude, []);
    const readding = catalog.setWorkspaces([repo]);
    catalog.dispose();
    await readding;
    assert.deepEqual(catalog.union(), []);
  });

  it('requires nonempty decoded descriptions for required metadata', async () => {
    const base = path.join(home, 'descriptions');
    const root = path.join(base, '.codex');
    for (const [name, description] of Object.entries({
      double: '""',
      single: "'' # empty",
      whitespace: '"  "',
      comment: '# no description',
      blockEmpty: '>\n  ',
      plain: 'Useful description # comment',
      quoted: '"Useful # description" # comment',
      folded: '>- # folded\n  Useful description',
      literal: '|\n  Useful description'
    })) {
      await skill(root, name, name, `---\nname: ${name}\ndescription: ${description}\n---\n`);
    }
    const catalog = discovery(base);
    await catalog.setWorkspaces([]);
    assert.deepEqual((await catalog.forCwd(base)).codex, ['folded', 'literal', 'plain', 'quoted']);
  });

  it('preserves canonical names, accepts optional metadata, and bounds linked traversal', async () => {
    const base = path.join(home, 'metadata');
    const root = path.join(base, '.claude');
    await skill(root, 'folder', 'caveman:caveman');
    await skill(
      root,
      'commented',
      'commented',
      '---\nname: commented-name # a YAML comment\ndescription: Fixture\n---\n'
    );
    await skill(
      root,
      'quoted',
      'quoted',
      '---\nname: "quoted-name" # another comment\ndescription: Fixture\n---\n'
    );
    await skill(root, 'empty', 'empty', '');
    await skill(root, 'body-only', 'body-only', 'A document without frontmatter.');
    await fs.mkdir(path.join(root, 'skills', 'not-a-skill'), { recursive: true });
    await linkDir(path.join(root, 'skills'), path.join(root, 'skills', 'cycle'));
    await linkDir(path.join(root, 'skills', 'folder'), path.join(root, 'skills', 'duplicate'));
    await skill(path.join(base, '.codex'), 'invalid', 'invalid', 'No metadata');
    await skill(path.join(base, '.codex'), '.system/nested-system', 'nested-system');
    const catalog = discovery(base);
    await catalog.setWorkspaces([]);
    assert.deepEqual((await catalog.forCwd(base)).claude, [
      'body-only',
      'caveman:caveman',
      'commented-name',
      'empty',
      'quoted-name'
    ]);
    assert.deepEqual((await catalog.forCwd(base)).codex, ['nested-system']);
    await skill(root, 'added-later');
    assert.ok(
      !(await catalog.forCwd(base)).claude?.includes('added-later'),
      'reads use the startup snapshot'
    );
  });
});
