import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';
import * as roots from '../../../scripts/fixture-roots.cjs';
import * as privateHelper from '../../../scripts/private-files-helper.mjs';
import * as consoleHelper from '../../../scripts/console-login-helper.mjs';
import * as crypto from 'node:crypto';
import * as packaged from '../../../scripts/packaged-bundles.mjs';
import { repoRoot } from '../helpers';
import * as fixture from './private_files_fixture';

for (const [kind, helper] of [
  ['private-files', privateHelper],
  ['console-login', consoleHelper]
] as const) {
  it(`${kind}: deploy verifies the exact packaged recipe and refuses changed or incomplete helper bytes`, () => {
    const root = repoRoot(),
      home = roots.create('squadron-deploy-helper-');
    try {
      const extension = path.join(home, 'extension');
      fixture.source(root, extension, kind);
      fixture.artifact(extension, undefined, kind);
      fs.writeFileSync(path.join(extension, 'dist/extension.js'), 'tested bundle');
      const expected = packaged.hashes(path.join(extension, 'dist'));
      const git = (...args: string[]): Buffer =>
        cp.execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: home });
      git('init', '--quiet');
      const archive = (): string => {
        git('add', 'extension');
        const tree = git('write-tree').toString().trim(),
          vsix = path.join(home, 'current.vsix');
        git('archive', '--format=zip', '--output', vsix, tree);
        return vsix;
      };
      packaged.verify(archive(), expected);
      packaged.verify(archive());
      const recipe = path.join(extension, `scripts/${kind}-helper.mjs`);
      fs.appendFileSync(recipe, '\n');
      assert.throws(
        () => packaged.verify(archive(), expected),
        /source, toolchain or protocol mismatch/
      );
      fs.copyFileSync(path.join(root, `scripts/${kind}-helper.mjs`), recipe);
      const shared = path.join(extension, 'scripts/windows-helper-artifacts.mjs');
      fs.appendFileSync(shared, '\n');
      assert.throws(
        () => packaged.verify(archive(), expected),
        /source, toolchain or protocol mismatch/
      );
      fs.unlinkSync(shared);
      assert.throws(
        () => packaged.verify(archive(), expected),
        /windows-helper-artifacts.mjs|ENOENT/
      );
      fs.copyFileSync(path.join(root, 'scripts/windows-helper-artifacts.mjs'), shared);
      const exe = path.join(extension, `dist/helpers/${kind}-v1.exe`),
        bytes = fs.readFileSync(exe);
      fs.appendFileSync(exe, 'changed');
      assert.throws(
        () => packaged.verify(archive(), expected),
        /do not match the tested candidate/
      );
      fs.writeFileSync(exe, bytes);
      fs.unlinkSync(exe);
      assert.throws(() => packaged.verify(archive()), /ENOENT/);
      fs.writeFileSync(exe, bytes);
      const manifestFile = path.join(extension, `dist/helpers/${kind}-v1.json`);
      const manifestBytes = fs.readFileSync(manifestFile);
      fs.unlinkSync(manifestFile);
      assert.throws(() => packaged.verify(archive()), /ENOENT/);
      fs.writeFileSync(manifestFile, manifestBytes);
      fs.unlinkSync(recipe);
      assert.throws(() => packaged.verify(archive(), expected), /helper.mjs|ENOENT/);
      fs.copyFileSync(path.join(root, `scripts/${kind}-helper.mjs`), recipe);
      fs.unlinkSync(exe);
      fs.unlinkSync(manifestFile);
      assert.throws(() => packaged.verify(archive()), /ENOENT/);
      fs.writeFileSync(
        path.join(extension, 'package.json'),
        JSON.stringify({ squadronBuild: 'posix-staging' })
      );
      packaged.verify(archive(), packaged.hashes(path.join(extension, 'dist')));
      fs.writeFileSync(exe, bytes);
      assert.throws(() => packaged.verify(archive()), /ENOENT/);
      fs.unlinkSync(exe);
      const other = kind === 'private-files' ? 'console-login' : 'private-files';
      fixture.source(root, extension, other);
      packaged.verify(archive(), packaged.hashes(path.join(extension, 'dist')));
      const otherExe = path.join(extension, `dist/helpers/${other}-v1.exe`);
      fs.writeFileSync(otherExe, bytes);
      assert.throws(() => packaged.verify(archive()), /ENOENT/);
      fs.unlinkSync(otherExe);
      fs.writeFileSync(path.join(extension, `dist/helpers/${other}-v1.json`), '{}');
      assert.throws(() => packaged.verify(archive()), /source, toolchain or protocol mismatch/);
    } finally {
      roots.remove(home);
    }
  });

  it(`${kind}: verifies helper source, artifact and public-release policy at the distribution boundary`, () => {
    const root = repoRoot(),
      home = roots.create('squadron-private-package-');
    try {
      const source = `src/core/platform/${kind.replaceAll('-', '_')}/helper`;
      fixture.source(root, home, kind);
      fixture.artifact(home, undefined, kind);
      const original = helper.verify(home);
      assert.equal(original.framework, '4.8.1');
      const publicResult = cp.spawnSync(
        process.execPath,
        [`scripts/${kind}-helper.mjs`, 'public'],
        { cwd: home, encoding: 'utf8' }
      );
      assert.equal(publicResult.status, 0, publicResult.stderr);
      const exe = path.join(home, `dist/helpers/${kind}-v1.exe`),
        bytes = fs.readFileSync(exe);
      const altered = Buffer.from(bytes);
      altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
      fs.writeFileSync(exe, altered);
      assert.throws(() => helper.verify(home), /digest mismatch/);
      fs.writeFileSync(exe, bytes);
      const manifestFile = path.join(home, `dist/helpers/${kind}-v1.json`);
      const manifestBytes = fs.readFileSync(manifestFile);
      const manifest = JSON.parse(manifestBytes.toString()) as {
        sha256: string;
        framework: string;
        sources: Record<string, string>;
        toolchain: Record<string, string>;
      };
      fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, framework: '4.8' }));
      assert.throws(() => helper.verify(home), /source, toolchain or protocol mismatch/);
      fs.writeFileSync(manifestFile, manifestBytes);
      for (const [offset, value, message] of [
        [0, 0, /not a PE/],
        [152, 0, /architecture mismatch/],
        [528, 0, /CLR architecture mismatch/]
      ] as const) {
        const malformed = Buffer.from(bytes);
        malformed.writeUInt16LE(value, offset);
        fs.writeFileSync(exe, malformed);
        fs.writeFileSync(
          manifestFile,
          JSON.stringify({
            ...manifest,
            sha256: crypto.createHash('sha256').update(malformed).digest('hex')
          })
        );
        assert.throws(() => helper.verify(home), message);
      }
      fs.writeFileSync(exe, bytes);
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({
          ...manifest,
          toolchain: { ...manifest.toolchain, 'csc.exe': '0'.repeat(64) }
        })
      );
      assert.throws(() => helper.verify(home), /source, toolchain or protocol mismatch/);
      delete manifest.sources.sharedRecipe;
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      assert.throws(() => helper.verify(home), /source, toolchain or protocol mismatch/);
      fs.writeFileSync(manifestFile, manifestBytes);
      const program = path.join(home, source, 'Program.cs');
      fs.appendFileSync(program, '\n');
      assert.throws(() => helper.verify(home), /source, toolchain or protocol mismatch/);
      fs.copyFileSync(path.join(root, source, 'Program.cs'), program);
      assert.equal(helper.verify(home).sha256, original.sha256);
      fs.unlinkSync(exe);
      assert.throws(() => helper.verify(home), /ENOENT/);
    } finally {
      roots.remove(home);
    }
  });
}
