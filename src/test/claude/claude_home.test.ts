import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { claudeConfigFile, claudeRoot } from '../../core/claude/home';
import * as fixtureRoots from '../../../scripts/fixture-roots.cjs';
import { disposeHome, tempHome } from '../home';

const HOME = path.resolve('/home/me');
const MOVED = path.resolve('/srv/claude-config');
const DEFAULT = { root: path.join(HOME, '.claude'), config: path.join(HOME, '.claude.json') };
const MOVED_TO = { root: MOVED, config: path.join(MOVED, '.claude.json') };

describe('where Claude keeps its state', () => {
  const cases: readonly (readonly [string, string | undefined, typeof DEFAULT])[] = [
    ['unset', undefined, DEFAULT],
    ['absolute', MOVED, MOVED_TO],
    ['absolute with a trailing separator', MOVED + path.sep, MOVED_TO],
    // The default's own directory is still a moved root to the CLI: its config
    // file goes inside, not beside it.
    [
      'the default directory spelled out',
      DEFAULT.root,
      { root: DEFAULT.root, config: path.join(DEFAULT.root, '.claude.json') }
    ],
    ['empty', '', DEFAULT],
    ['blank', '   ', DEFAULT],
    ['padded', ` ${MOVED}`, DEFAULT],
    ['relative', 'claude-config', DEFAULT],
    ['a literal tilde', '~/claude-config', DEFAULT]
  ];

  for (const [name, value, want] of cases) {
    it(`reads ${name}`, () => {
      const env = value === undefined ? {} : { CLAUDE_CONFIG_DIR: value };
      assert.equal(claudeRoot(HOME, env), want.root);
      assert.equal(claudeConfigFile(HOME, env), want.config);
    });
  }
});

describe('a variable inherited from the reader', () => {
  it('does not survive into a test home, where it would aim writes at their real root', async () => {
    process.env['CLAUDE_CONFIG_DIR'] = path.resolve('/reader/claude-config');
    const home = await tempHome();
    try {
      assert.equal(process.env['CLAUDE_CONFIG_DIR'], undefined);
    } finally {
      delete process.env['CLAUDE_CONFIG_DIR'];
      await disposeHome(home);
    }
  });
});

describe('an environment copied for a child', () => {
  it('loses the variable in every casing, which win32 reads as one name', () => {
    const copy = {
      CLAUDE_CONFIG_DIR: 'upper',
      claude_config_dir: 'lower',
      Claude_Config_Dir: 'mixed',
      KEPT: 'kept'
    };
    assert.deepEqual(fixtureRoots.withoutCliRoots(copy), { KEPT: 'kept' });
  });
});

describe('with CLAUDE_CONFIG_DIR set before anything loads', () => {
  let home: string;
  let moved: string;
  let paths: typeof import('../../core/paths');

  before(async () => {
    home = await tempHome();
    moved = path.join(home, 'elsewhere');
    process.env['CLAUDE_CONFIG_DIR'] = moved;
    paths = await import('../../core/paths');
  });

  after(async () => {
    delete process.env['CLAUDE_CONFIG_DIR'];
    await disposeHome(home);
  });

  it('puts every CLI location under the one root', () => {
    assert.deepEqual(
      [
        paths.CLAUDE_DIR,
        paths.SESSIONS_DIR,
        paths.DUMP_DIR,
        paths.CLAUDE_SKILLS_DIR,
        paths.SETTINGS_FILE,
        paths.CLAUDE_CONFIG_FILE,
        paths.MCP_NEEDS_AUTH_FILE,
        paths.TASKS_DIR
      ],
      [
        moved,
        path.join(moved, 'sessions'),
        path.join(moved, 'squadron'),
        path.join(moved, 'skills'),
        path.join(moved, 'settings.json'),
        path.join(moved, '.claude.json'),
        path.join(moved, 'mcp-needs-auth-cache.json'),
        path.join(moved, 'tasks')
      ]
    );
  });

  it('keeps our own store under the home', () => {
    assert.equal(paths.STATE_DIR, path.join(home, '.squadron'));
  });
});
