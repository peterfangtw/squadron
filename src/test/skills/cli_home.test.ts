import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { codexRoot } from '../../core/codex/home';
import { grokRoot } from '../../core/grok/home';
import * as fixtureRoots from '../../../scripts/fixture-roots.cjs';
import { disposeHome, homeEnv, tempHome, writeJson } from '../home';
import { linkDir } from '../helpers';

const HOME = path.resolve('/home/me');
const MOVED = path.resolve('/srv/cli state');

describe('where Codex and Grok keep their state', () => {
  const brands = [
    { name: 'CODEX_HOME', root: codexRoot, fallback: path.join(HOME, '.codex') },
    { name: 'GROK_HOME', root: grokRoot, fallback: path.join(HOME, '.grok') }
  ];
  const cases: readonly (readonly [string, string | undefined, string | undefined])[] = [
    ['unset', undefined, undefined],
    ['absolute', MOVED, MOVED],
    ['absolute with a trailing separator', MOVED + path.sep, MOVED],
    ['empty', '', undefined],
    ['padded', ` ${MOVED} `, undefined],
    ['relative', 'moved', undefined],
    ['a literal tilde', '~/moved', undefined],
    // On win32 this names a different place from each drive; on POSIX it is relative.
    ['rooted with no drive', '\\moved', undefined],
    ...(path.sep === '\\'
      ? ([
          ['two separators and no share', '\\\\moved', undefined],
          ['forward separators and no share', '//moved', undefined],
          ['bare separators', '//', undefined],
          ['a UNC share', '\\\\server\\share\\state', '\\\\server\\share\\state']
        ] as const)
      : [])
  ];
  for (const brand of brands) {
    for (const [label, value, expected] of cases) {
      it(`${brand.name} ${label}`, () => {
        const env = value === undefined ? {} : { [brand.name]: value };
        assert.equal(brand.root(HOME, env), expected ?? brand.fallback);
      });
    }
  }
});

describe('an environment copied for a child', () => {
  it('loses every CLI root in every casing, which win32 reads as one name', () => {
    assert.deepEqual(
      fixtureRoots.withoutCliRoots({
        CLAUDE_CONFIG_DIR: 'a',
        codex_home: 'b',
        Grok_Home: 'c',
        KEPT: 'kept'
      }),
      { KEPT: 'kept' }
    );
  });
});

describe('with CODEX_HOME and GROK_HOME set before anything loads', () => {
  let home: string;
  let codex: string;
  let grok: string;
  let paths: typeof import('../../core/paths');
  let transcript: typeof import('../../core/grok/transcript');

  before(async () => {
    home = await tempHome();
    codex = path.join(home, 'codex-state');
    grok = path.join(home, 'grok-state');
    process.env['CODEX_HOME'] = codex;
    process.env['GROK_HOME'] = grok;
    paths = await import('../../core/paths');
    transcript = await import('../../core/grok/transcript');
  });

  after(async () => {
    delete process.env['CODEX_HOME'];
    delete process.env['GROK_HOME'];
    await disposeHome(home);
  });

  it('puts every CLI location under its root', () => {
    assert.deepEqual(
      [paths.GROK_DIR, paths.GROK_CONFIG_FILE, paths.GROK_MCP_CREDENTIALS_FILE, paths.CODEX_DIR],
      [grok, path.join(grok, 'config.toml'), path.join(grok, 'mcp_credentials.json'), codex]
    );
    assert.equal(
      transcript.grokTranscriptPath('/w', 's'),
      path.join(grok, 'sessions', '%2Fw', 's', 'chat_history.jsonl')
    );
  });

  it('names the moved roots, which no hidden directory protects', () => {
    assert.deepEqual([...paths.MOVED_CLI_ROOTS].sort(), [codex, grok].sort());
  });

  it('keeps an explicit home apart from the override', () => {
    const other = path.join(home, 'other');
    assert.equal(paths.grokHome(other), path.join(other, '.grok'));
    assert.equal(paths.grokHome(), grok);
  });

  it('hands each adapter its moved root, so the skill installs there', async () => {
    const { adapter } = await import('../../core/adapter');
    assert.equal(adapter('codex')?.skillRoot(home, process.env), codex);
    assert.equal(adapter('grok')?.skillRoot(home, process.env), grok);
  });

  it('reads each sign-in file from the moved root', async () => {
    const { codexAuthStamp } = await import('../../core/codex/auth');
    const { grokAuthStamp } = await import('../../core/grok/auth');
    const empty = [await codexAuthStamp(), await grokAuthStamp()];
    await writeJson(path.join(codex, 'auth.json'), {});
    await writeJson(path.join(grok, 'auth.json'), {});
    const stamped = [await codexAuthStamp(), await grokAuthStamp()];
    assert.notEqual(stamped[0], empty[0]);
    assert.notEqual(stamped[1], empty[1]);
  });

  it('never sends a file from a moved root, with no hidden directory in its way', async () => {
    const rules = await import('../../core/remote/attach');
    const file = path.join(grok, 'auth.json');
    await writeJson(file, {});
    const real = await fs.realpath(file);
    const deny = await rules.attachDeny([home], paths.NEVER_SENT_DIRS);
    assert.equal(rules.checkPath({ given: real, real }, [home], []).ok, true);
    assert.equal(rules.checkPath({ given: real, real }, [home], deny).ok, false);
  });

  it('does not read a case difference as a link', async (t) => {
    const install = await import('../../core/skill_install');
    await fs.mkdir(path.join(home, 'spelled-state'));
    const spelled = path.join(home, 'SPELLED-STATE');
    if (!(await fs.stat(spelled).catch(() => undefined))) {
      return t.skip('env: this volume is case-sensitive');
    }
    const [cliDir, parent] = install.skillTarget(spelled);
    assert.equal(await install.skillStatus(cliDir, parent), 'missing');
  });

  it('keeps a filesystem root whole through the split', async () => {
    const { skillPaths, skillTarget } = await import('../../core/skill_install');
    const roots = [path.parse(home).root, ...(path.sep === '\\' ? ['\\\\server\\share\\'] : [])];
    for (const root of roots) assert.equal(skillPaths(...skillTarget(root)).cliRoot, root);
  });

  it('still refuses a linked root', async () => {
    const install = await import('../../core/skill_install');
    const real = path.join(home, 'real-root');
    await fs.mkdir(real);
    await linkDir(real, path.join(home, 'linked-root'));
    const [cliDir, parent] = install.skillTarget(path.join(home, 'linked-root'));
    assert.equal(await install.skillStatus(cliDir, parent), 'foreign');
  });

  it('clears both for the next rig', async () => {
    const next = await tempHome();
    try {
      assert.equal(process.env['CODEX_HOME'], undefined);
      assert.equal(process.env['GROK_HOME'], undefined);
    } finally {
      await disposeHome(next);
      Object.assign(process.env, homeEnv(home));
    }
  });
});
