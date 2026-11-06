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
  it(
    'shares concurrent refreshes and keeps the published catalog readable until completion',
    { timeout: 10_000 },
    async (t) => {
      let now = 0;
      t.mock.method(performance, 'now', () => now);
      const base = path.join(home, 'concurrent-refresh');
      await skill(base, 'before');
      let published = 0;
      const catalog = new skills.SkillDiscovery(
        [{ brand: 'codex', skillSources: () => [{ directory: path.join(base, 'skills') }] }],
        base,
        {},
        () => published++
      );
      await catalog.setWorkspaces([]);
      await skill(base, 'after');
      let release = (): void => {};
      let began = (): void => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const reading = new Promise<void>((resolve) => (began = resolve));
      const readdir = fs.readdir;
      let reads = 0;
      t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
        reads++;
        began();
        await gate;
        return readdir(...args);
      });
      now = 60_000;
      const first = catalog.refresh();
      const second = catalog.refresh();
      await reading;
      assert.deepEqual(catalog.union(), ['before']);
      assert.deepEqual((await catalog.forCwd(base)).codex, ['before']);
      assert.equal(published, 0);
      release();
      await Promise.all([first, second]);
      assert.deepEqual(catalog.union(), ['after', 'before']);
      assert.equal(published, 1);
      assert.equal(reads, 1, 'concurrent requests share one source-directory read');
    }
  );

  for (const action of ['remove workspace', 'dispose'] as const) {
    it(`discards a refresh finishing after ${action}`, { timeout: 10_000 }, async (t) => {
      let now = 0;
      t.mock.method(performance, 'now', () => now);
      const base = path.join(home, action.replaceAll(' ', '-'));
      const repo = path.join(base, 'repo');
      await skill(path.join(base, '.codex'), 'global');
      await skill(path.join(repo, '.codex'), 'project');
      const catalog = discovery(base);
      await catalog.setWorkspaces([repo]);
      await skill(path.join(repo, '.codex'), 'added');
      let release = (): void => {};
      let began = (): void => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const reading = new Promise<void>((resolve) => (began = resolve));
      const readdir = fs.readdir;
      t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
        began();
        await gate;
        return readdir(...args);
      });
      now = 60_000;
      const refresh = catalog.refresh();
      await reading;
      if (action === 'dispose') catalog.dispose();
      else await catalog.setWorkspaces([]);
      release();
      await refresh;
      assert.deepEqual(catalog.union(), action === 'dispose' ? [] : ['global']);
    });
  }

  it('retains published data after a failed refresh and limits retries to once per minute', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const base = path.join(home, 'failed-refresh');
    await skill(base, 'before');
    let fail = false;
    let attempts = 0;
    const catalog = new skills.SkillDiscovery(
      [
        {
          brand: 'codex',
          skillSources: () => {
            attempts++;
            if (fail) throw new Error('source unavailable');
            return [{ directory: path.join(base, 'skills') }];
          }
        }
      ],
      base,
      {}
    );
    await catalog.forCwd(base);
    await skill(base, 'after');
    fail = true;
    now = 60_000;
    await assert.rejects(catalog.refresh(), /source unavailable/);
    assert.deepEqual(catalog.union(), ['before']);
    fail = false;
    now = 119_999;
    await catalog.refresh();
    assert.equal(attempts, 2);
    now = 120_000;
    await catalog.refresh();
    assert.deepEqual(catalog.union(), ['after', 'before']);
  });

  it('does not replace a workspace change that starts while refresh awaits initialization', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const base = path.join(home, 'workspace-start-race');
    const before = path.join(base, 'before');
    const after = path.join(base, 'after');
    await skill(path.join(base, '.codex'), 'global');
    await skill(path.join(before, '.codex'), 'old-project');
    await skill(path.join(after, '.codex'), 'new-project');
    const catalog = discovery(base);
    await catalog.setWorkspaces([before]);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readdir = fs.readdir;
    t.mock.method(fs, 'readdir', async (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === path.join(base, '.codex', 'skills')) await gate;
      return readdir(...args);
    });
    now = 60_000;
    const refresh = catalog.refresh();
    await catalog.setWorkspaces([after]);
    release();
    await refresh;
    assert.deepEqual((await catalog.forCwd(before)).codex, ['global']);
    assert.deepEqual((await catalog.forCwd(after)).codex, ['global', 'new-project']);
  });

  it('refreshes global, project and linked metadata only on demand after one minute', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const base = path.join(home, 'refresh');
    const repo = path.join(base, 'repo');
    const external = path.join(base, 'external');
    await skill(path.join(base, '.codex'), 'removed');
    await skill(path.join(repo, '.codex'), 'project', 'before');
    await skill(external, 'linked', 'linked-before');
    await linkDir(
      path.join(external, 'skills', 'linked'),
      path.join(base, '.codex', 'skills', 'link')
    );
    const catalog = discovery(base);
    await catalog.setWorkspaces([repo]);
    assert.deepEqual((await catalog.forCwd(repo)).codex, ['before', 'linked-before', 'removed']);
    await fs.unlink(path.join(base, '.codex', 'skills', 'removed', 'SKILL.md'));
    await skill(path.join(base, '.codex'), 'added');
    await skill(path.join(repo, '.codex'), 'project', 'after');
    await skill(external, 'linked', 'linked-after');
    now = 59_999;
    await catalog.refresh();
    assert.deepEqual((await catalog.forCwd(repo)).codex, ['before', 'linked-before', 'removed']);
    now = 60_000;
    assert.deepEqual((await catalog.forCwd(repo)).codex, ['before', 'linked-before', 'removed']);
    await Promise.all([catalog.refresh(), catalog.refresh()]);
    assert.deepEqual((await catalog.forCwd(repo)).codex, ['added', 'after', 'linked-after']);
    assert.deepEqual(catalog.union(), ['added', 'after', 'linked-after']);
  });

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
      'reads retain the published snapshot until a refresh is requested'
    );
  });
});
