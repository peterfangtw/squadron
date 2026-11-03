import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import * as roots from '../../../scripts/fixture-roots.cjs';
import * as privateHelper from '../../../scripts/private-files-helper.mjs';
import * as consoleHelper from '../../../scripts/console-login-helper.mjs';
import { repoRoot, testPlatform } from '../helpers';
import * as fixture from './private_files_fixture';

const CLEAN: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(GIT_|SQUADRON_(PRIVATE_FILES|CONSOLE_LOGIN)_)/.test(key)
  )
);

for (const [kind, helper] of [
  ['private-files', privateHelper],
  ['console-login', consoleHelper]
] as const) {
  it(`${kind}: provisions absolute verified imports from a linked worktree into a source archive without Git metadata`, () => {
    const root = repoRoot(),
      home = roots.create('squadron-helper-inputs-');
    try {
      const prefix = `SQUADRON_${kind.replaceAll('-', '_').toUpperCase()}`;
      const origin = path.join(home, 'origin'),
        linked = path.join(home, 'linked'),
        archive = path.join(home, 'archive');
      fixture.source(root, origin, kind);
      const git = (...args: string[]): string =>
        cp
          .execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
            cwd: origin,
            env: CLEAN,
            encoding: 'utf8'
          })
          .trim();
      git('init', '--quiet');
      git('add', '.');
      git(
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      );
      git('worktree', 'add', '--quiet', '--detach', linked);
      assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
      assert.equal(
        helper.buildEnvironment(linked, CLEAN)[`${prefix}_REFERENCES`],
        path.join(origin, '.git/squadron-helper-toolchains/net48-1.0.3')
      );
      fixture.source(root, archive, kind);
      assert.equal(fs.existsSync(path.join(archive, '.git')), false);
      const inputs = path.join(home, 'inputs');
      fixture.artifact(origin, inputs, kind);
      const manifest = path.join(inputs, `${kind}-v1.json`);
      const environment = helper.buildEnvironment(linked, {
        ...CLEAN,
        [`${prefix}_INPUT`]: '../inputs',
        [`${prefix}_INPUT_MANIFEST_SHA256`]: crypto
          .createHash('sha256')
          .update(fs.readFileSync(manifest))
          .digest('hex')
      });
      assert.equal(environment[`${prefix}_INPUT`], inputs);
      const run = (directory: string, env = environment): cp.SpawnSyncReturns<string> =>
        cp.spawnSync(process.execPath, [`scripts/${kind}-helper.mjs`], {
          cwd: directory,
          env: { ...CLEAN, ...env },
          encoding: 'utf8',
          timeout: 30000
        });
      for (const directory of [linked, archive]) {
        const result = run(directory);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(helper.verify(directory).sha256, helper.verify(origin, inputs).sha256);
        assert.deepEqual(
          fs.readFileSync(path.join(directory, `dist/helpers/${kind}-v1.json`)),
          fs.readFileSync(manifest)
        );
      }
      const wrongPin = run(archive, {
        ...environment,
        [`${prefix}_INPUT_MANIFEST_SHA256`]: '0'.repeat(64)
      });
      assert.notEqual(wrongPin.status, 0);
      assert.match(wrongPin.stderr, /independently supplied SHA-256 pin/);
      fs.appendFileSync(path.join(inputs, `${kind}-v1.exe`), 'changed');
      const changed = run(archive);
      assert.notEqual(changed.status, 0);
      assert.match(changed.stderr, /artifact digest mismatch/);
    } finally {
      roots.remove(home);
    }
  });

  it(
    `${kind}: builds against pinned references in the Git common directory of a linked worktree`,
    {
      skip: testPlatform() !== 'win32' && 'win32: compilation uses the pinned Framework compiler'
    },
    () => {
      const root = repoRoot(),
        home = roots.create('squadron-helper-references-');
      try {
        const prefix = `SQUADRON_${kind.replaceAll('-', '_').toUpperCase()}`;
        const origin = path.join(home, 'origin'),
          linked = path.join(home, 'linked'),
          archive = path.join(home, 'archive');
        fixture.source(root, origin, kind);
        const git = (...args: string[]): string =>
          cp
            .execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
              cwd: origin,
              env: CLEAN,
              encoding: 'utf8'
            })
            .trim();
        git('init', '--quiet');
        git('add', '.');
        git(
          '-c',
          'user.name=test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--quiet',
          '-m',
          'fixture'
        );
        git('worktree', 'add', '--quiet', '--detach', linked);
        const references = helper.buildEnvironment(origin, CLEAN)[`${prefix}_REFERENCES`]!;
        const available = helper.buildEnvironment(root)[`${prefix}_REFERENCES`]!;
        fs.cpSync(available, references, { recursive: true });
        for (const [directory, environment] of [
          [linked, CLEAN],
          [archive, { ...CLEAN, ...helper.buildEnvironment(linked, CLEAN) }]
        ] as const) {
          if (directory === archive) fixture.source(root, archive, kind);
          const result = cp.spawnSync(process.execPath, [`scripts/${kind}-helper.mjs`], {
            cwd: directory,
            env: environment,
            encoding: 'utf8',
            timeout: 30000
          });
          assert.equal(result.status, 0, result.stderr);
          helper.verify(directory);
        }
      } finally {
        roots.remove(home);
      }
    }
  );
}

it('emits development JS without Windows inputs on POSIX while complete emission refuses them', () => {
  const root = repoRoot(),
    home = roots.create('squadron-helper-emission-');
  try {
    fixture.source(root, home);
    for (const file of ['tsconfig.json', 'CHANGELOG.md'])
      fs.copyFileSync(path.join(root, file), path.join(home, file));
    fs.writeFileSync(path.join(home, 'package.json'), '{}');
    fs.copyFileSync(path.join(root, 'scripts/esbuild.mjs'), path.join(home, 'scripts/esbuild.mjs'));
    fs.copyFileSync(
      path.join(root, 'scripts/console-login-helper.mjs'),
      path.join(home, 'scripts/console-login-helper.mjs')
    );
    fs.cpSync(path.join(root, 'src'), path.join(home, 'src'), {
      recursive: true,
      filter: (file) => file !== path.join(root, 'src/test')
    });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(home, 'node_modules'), 'junction');
    // The host is simulated here; esbuild still executes this machine's actual binary.
    const esbuildBinary = cp
      .execFileSync(
        process.execPath,
        [
          '-p',
          "require.resolve('@esbuild/' + process.platform + '-' + process.arch + '/' + (process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'))"
        ],
        { cwd: root, encoding: 'utf8' }
      )
      .trim();
    const preload = path.join(home, 'posix.cjs');
    fs.writeFileSync(
      preload,
      "Object.defineProperty(process, 'platform', {value: process.env.EMIT_PLATFORM});"
    );
    for (const platform of ['darwin', 'linux']) {
      const run = (args: string[] = []): cp.SpawnSyncReturns<string> =>
        cp.spawnSync(process.execPath, ['--require', preload, 'scripts/esbuild.mjs', ...args], {
          cwd: home,
          env: { ...CLEAN, ESBUILD_BINARY_PATH: esbuildBinary, EMIT_PLATFORM: platform },
          encoding: 'utf8',
          timeout: 30000
        });
      const development = run();
      assert.equal(development.status, 0, development.stderr);
      assert.match(development.stdout, /development JS emission/);
      assert.match(
        fs.readFileSync(path.join(home, 'dist/extension.js'), 'utf8'),
        /const __SQUADRON_PRIVATE_FILES_SHA256__ = null;/
      );
      assert.ok(fs.existsSync(path.join(home, 'dist/squadron-send.js')));
      const complete = run(['--package']);
      assert.notEqual(complete.status, 0);
      assert.match(complete.stderr, /same-source verified Windows build input/);
      const manifestFile = path.join(home, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({ ...manifest, squadronBuild: 'posix-staging' })
      );
      const staging = run(['--package']);
      assert.equal(staging.status, 0, staging.stderr);
      assert.match(
        fs.readFileSync(path.join(home, 'dist/extension.js'), 'utf8'),
        /const __SQUADRON_CONSOLE_LOGIN_SHA256__ = null;/
      );
      assert.match(
        fs.readFileSync(path.join(home, 'dist/extension.js'), 'utf8'),
        /const __SQUADRON_PRIVATE_FILES_SHA256__ = null;/
      );
      delete manifest.squadronBuild;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    const inputs = path.join(home, 'inputs');
    const environment: NodeJS.ProcessEnv = { ...CLEAN };
    const pins: Record<string, string> = {};
    for (const kind of ['private-files', 'console-login'] as const) {
      fixture.artifact(home, inputs, kind);
      const prefix = `SQUADRON_${kind.replaceAll('-', '_').toUpperCase()}`;
      environment[`${prefix}_INPUT`] = inputs;
      environment[`${prefix}_INPUT_MANIFEST_SHA256`] = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(inputs, `${kind}-v1.json`)))
        .digest('hex');
      pins[`__${prefix}_SHA256__`] = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(inputs, `${kind}-v1.exe`)))
        .digest('hex');
    }
    assert.notEqual(pins.__SQUADRON_PRIVATE_FILES_SHA256__, pins.__SQUADRON_CONSOLE_LOGIN_SHA256__);
    const imported = cp.spawnSync(process.execPath, ['scripts/esbuild.mjs', '--package'], {
      cwd: home,
      env: environment,
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(imported.status, 0, imported.stderr);
    for (const bundle of ['extension.js', 'squadron-send.js']) {
      const bytes = fs.readFileSync(path.join(home, 'dist', bundle), 'utf8');
      for (const [name, digest] of Object.entries(pins))
        assert.ok(bytes.includes(`const ${name} = "${digest}";`), `${bundle}: ${name}`);
    }
  } finally {
    roots.remove(home);
  }
});
