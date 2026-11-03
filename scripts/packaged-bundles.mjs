import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zip from './zip.mjs';
import * as artifacts from './windows-helper-artifacts.mjs';

export function hashes(directory) {
  const walk = (at) =>
    fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(at, entry.name);
      return entry.isDirectory() ? walk(file) : [path.relative(directory, file)];
    });
  return JSON.stringify(
    walk(directory)
      .sort()
      .map((file) => [
        file,
        crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(directory, file)))
          .digest('hex')
      ])
  );
}

// VSCE runs vscode:prepublish during packaging; source hashes cannot prove the packaged bytes.
export function verify(vsix, expected) {
  const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-package-'));
  try {
    zip.extract(vsix, 'extension/dist/', unpacked);
    const shipped = path.join(unpacked, 'extension/dist');
    if (!fs.existsSync(shipped) || (expected !== undefined && hashes(shipped) !== expected))
      throw new Error('packaged bundles do not match the tested candidate');
    const packagedRoot = path.join(unpacked, 'extension');
    zip.extract(vsix, 'extension/package.json', unpacked);
    for (const helper of artifacts.HELPERS) {
      zip.extract(vsix, `extension/${helper.source}/`, unpacked);
      if (
        fs.existsSync(path.join(packagedRoot, helper.source)) ||
        fs.existsSync(path.join(shipped, `helpers/${helper.name}.json`)) ||
        fs.existsSync(path.join(shipped, `helpers/${helper.name}.exe`))
      ) {
        fs.mkdirSync(path.join(packagedRoot, 'scripts'), { recursive: true });
        for (const file of [artifacts.RECIPE, helper.recipe]) {
          const entry = `extension/${file}`;
          fs.writeFileSync(path.join(unpacked, entry), zip.entry(vsix, entry));
        }
        artifacts.verifyBuild(helper, packagedRoot, path.join(shipped, 'helpers'));
      }
    }
  } finally {
    fs.rmSync(unpacked, { recursive: true, force: true });
  }
}
