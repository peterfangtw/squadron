import * as assert from 'node:assert/strict';
import * as child from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { it } from 'node:test';
import { linkDir, repoRoot } from '../helpers';

const ROOT = repoRoot();
const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);

it(
  'rebuilds assets and replays CLI captures with only public source files',
  {
    skip: !existsSync(path.join(ROOT, '.git')) && 'env: source archive has no Git index to filter'
  },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-public-export-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const files = child.execFileSync('git', ['ls-files', '--cached', '-z'], {
      cwd: ROOT,
      env: CLEAN
    });
    const excluded = new Set(
      child
        .execFileSync(
          'git',
          ['ls-files', '--cached', '--ignored', '--exclude-from=.publicignore', '-z'],
          { cwd: ROOT, env: CLEAN }
        )
        .toString()
        .split('\0')
    );
    for (const file of files.toString().split('\0').filter(Boolean)) {
      if (excluded.has(file)) continue;
      const dest = path.join(dir, file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(path.join(ROOT, file), dest);
    }
    // The gate already compiled these modules. Copying keeps repoRoot() inside
    // the filtered tree; a link would resolve back to the private checkout.
    await fs.cp(path.join(ROOT, 'out'), path.join(dir, 'out'), { recursive: true });
    await linkDir(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    for (const args of [
      ['scripts/mascot.mjs', '--check'],
      ['scripts/icons.mjs'],
      [
        '--test',
        'out/test/claude/claude_tee.test.js',
        'out/test/codex/codex_tee.test.js',
        'out/test/grok/grok_tee_flows.test.js'
      ]
    ]) {
      const result = child.spawnSync(process.execPath, args, {
        cwd: dir,
        env: { ...process.env, SQUADRON_CHROME: '' },
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024
      });
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    }
  }
);
