import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { Effects, Launchers } from '../../core/platform/launchers';
import * as darwin from '../../core/platform/launchers/darwin';
import * as platform from '../../core/platform';
import { testPlatform } from '../helpers';

const run = promisify(execFile);

/** The banner esbuild writes. Install must copy it, not add a second one. */
const TEXT = "#!/usr/bin/env node\nprocess.stdout.write('verb-installed\\n');\n";
const REPLACEMENT = "#!/usr/bin/env node\nprocess.stdout.write('replaced\\n');\n";

const shebangExecSkip =
  testPlatform() === 'win32' && 'win32: an extensionless shebang file cannot be spawned — W1.1';

const real: Effects = {
  async mkdir(dir) {
    await fs.mkdir(dir, { recursive: true });
  },
  copyFile: (source, destination) => fs.copyFile(source, destination),
  chmod: (file, mode) => fs.chmod(file, mode)
};

const factories = [['darwin', darwin.launchers]] as const;

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launchers-'));
  try {
    await body(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function bundle(dir: string, text: string): Promise<string> {
  const file = path.join(dir, 'dist', 'squadron-step.js');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  await fs.chmod(file, 0o644);
  return file;
}

/** `install` plus the modes it asked for, so a missing chmod fails on every host. */
function recording(make: (effects: Effects) => Launchers): {
  install: Launchers['install'];
  asked: [string, number][];
} {
  const asked: [string, number][] = [];
  const install = make({
    ...real,
    chmod: async (file, mode) => {
      asked.push([file, mode]);
      await real.chmod(file, mode);
    }
  }).install;
  return { install, asked };
}

describe('verb installation', () => {
  it('keeps the POSIX hook runtime and one launcher for every shell', () => {
    const launchers = darwin.launchers(real);
    assert.deepEqual(launchers.scriptCommand(), {
      program: '/usr/bin/env node',
      quoting: 'literal'
    });
    for (const shell of ['posix', 'windows-powershell'] as const) {
      assert.equal(
        launchers.verbPath('/x/bin', 'squadron-step', shell),
        path.join('/x/bin', 'squadron-step')
      );
    }
  });

  it('locates the POSIX JavaScript entry without filesystem effects', () => {
    const effects: Effects = {
      mkdir: () => {
        throw new Error('unexpected mkdir');
      },
      copyFile: () => {
        throw new Error('unexpected copy');
      },
      chmod: () => {
        throw new Error('unexpected chmod');
      }
    };
    assert.equal(
      darwin.launchers(effects).scriptPath('/bin dir', 'verb'),
      path.join('/bin dir', 'verb')
    );
  });
  it('copies the bundle extensionless, shebang and all, and asks for mode 0755', async () => {
    for (const [label, make] of factories) {
      await withRoot(async (root) => {
        const source = await bundle(root, TEXT);
        const bin = path.join(root, 'nested', 'bin');
        const dest = path.join(bin, 'squadron-step');
        const { install, asked } = recording(make);
        await install(bin, 'squadron-step', source);
        assert.equal(await fs.readFile(dest, 'utf8'), TEXT, label);
        assert.equal(await fs.readFile(source, 'utf8'), TEXT, `${label} source`);
        assert.deepEqual(asked, [[dest, 0o755]], label);
        assert.deepEqual(await fs.readdir(bin), ['squadron-step'], label);
        if (testPlatform() !== 'win32') {
          // win32 chmod does not leave a Unix mode to read (W1.1). The asked
          // mode above is the contract there; here the bits have to land.
          assert.equal((await fs.stat(dest)).mode & 0o777, 0o755, label);
          assert.equal((await fs.stat(source)).mode & 0o777, 0o644, `${label} source`);
        }
        await fs.writeFile(source, REPLACEMENT);
        await install(bin, 'squadron-step', source);
        assert.equal(await fs.readFile(dest, 'utf8'), REPLACEMENT, `${label} rewrite`);
        assert.deepEqual(await fs.readdir(bin), ['squadron-step'], `${label} rewrite`);
      });
    }

    await withRoot(async (root) => {
      const source = await bundle(root, TEXT);
      const bin = path.join(root, 'bin');
      const dest = path.join(bin, 'squadron-step');
      const install =
        testPlatform() === 'win32' ? darwin.launchers(real).install : platform.launchers.install;
      await install(bin, 'squadron-step', source);
      assert.equal(await fs.readFile(dest, 'utf8'), TEXT);
      assert.deepEqual(await fs.readdir(bin), ['squadron-step']);
      if (testPlatform() !== 'win32') {
        assert.equal((await fs.stat(dest)).mode & 0o777, 0o755);
      }
    });
  });

  it('runs the installed bundle under node', async () => {
    await withRoot(async (root) => {
      const source = await bundle(root, TEXT);
      const bin = path.join(root, 'bin');
      await platform.launchers.install(bin, 'squadron-step', source);
      const installed = platform.launchers.scriptPath(bin, 'squadron-step');
      const result = await run(process.execPath, [installed], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.stdout, 'verb-installed\n');
    });
  });

  it('runs the installed bundle by its shebang', { skip: shebangExecSkip }, async () => {
    await withRoot(async (root) => {
      const source = await bundle(root, TEXT);
      const installed = path.join(root, 'bin', 'squadron-step');
      await platform.launchers.install(path.dirname(installed), 'squadron-step', source);
      const result = await run(installed, [], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.stdout, 'verb-installed\n');
    });
  });

  it('a missing bundle resolves and leaves its siblings installed', async () => {
    for (const [label, make] of factories) {
      await withRoot(async (root) => {
        const kept = await bundle(root, TEXT);
        const later = path.join(root, 'dist', 'squadron-send.js');
        await fs.writeFile(later, REPLACEMENT);
        const bin = path.join(root, 'bin');
        const install = make(real).install;
        await install(bin, 'squadron-step', kept);
        const before = await fs.readFile(path.join(bin, 'squadron-step'), 'utf8');
        await install(bin, 'squadron-missing', path.join(root, 'dist', 'absent.js'));
        await install(bin, 'squadron-send', later);
        assert.equal(await fs.readFile(path.join(bin, 'squadron-step'), 'utf8'), before, label);
        assert.equal(
          await fs.readFile(path.join(bin, 'squadron-send'), 'utf8'),
          REPLACEMENT,
          label
        );
        await assert.rejects(
          fs.stat(path.join(bin, 'squadron-missing')),
          { code: 'ENOENT' },
          label
        );
        assert.deepEqual((await fs.readdir(bin)).sort(), ['squadron-send', 'squadron-step'], label);
      });
    }
  });

  it('leaves the copied bytes when chmod fails, and still resolves', async () => {
    for (const [label, make] of factories) {
      await withRoot(async (root) => {
        const source = await bundle(root, TEXT);
        const bin = path.join(root, 'bin');
        const dest = path.join(bin, 'squadron-step');
        let asked: number | undefined;
        const install = make({
          ...real,
          chmod: (file, mode) => {
            assert.equal(file, dest, label);
            asked = mode;
            return Promise.reject(new Error('EPERM'));
          }
        }).install;
        await install(bin, 'squadron-step', source);
        assert.equal(asked, 0o755, label);
        assert.equal(await fs.readFile(dest, 'utf8'), TEXT, label);
        assert.deepEqual(await fs.readdir(bin), ['squadron-step'], label);
      });
    }
  });

  it('installs nothing when the directory cannot be made, and still resolves', async () => {
    for (const [label, make] of factories) {
      await withRoot(async (root) => {
        const source = await bundle(root, TEXT);
        const bin = path.join(root, 'bin');
        let copied = 0;
        let chmod = 0;
        const install = make({
          mkdir: () => Promise.reject(new Error('EACCES')),
          copyFile: () => {
            copied += 1;
            return Promise.resolve();
          },
          chmod: () => {
            chmod += 1;
            return Promise.resolve();
          }
        }).install;
        await install(bin, 'squadron-step', source);
        assert.equal(copied, 0, label);
        assert.equal(chmod, 0, label);
        await assert.rejects(fs.stat(path.join(bin, 'squadron-step')));
      });
    }
  });
});
