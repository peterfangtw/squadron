import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Kind = 'private-files' | 'console-login';

export function source(root: string, destination: string, kind: Kind = 'private-files'): void {
  const input = `src/core/platform/${kind.replaceAll('-', '_')}/helper`;
  fs.mkdirSync(path.join(destination, 'scripts'), { recursive: true });
  for (const recipe of [`${kind}-helper.mjs`, 'windows-helper-artifacts.mjs'])
    fs.copyFileSync(path.join(root, 'scripts', recipe), path.join(destination, 'scripts', recipe));
  fs.cpSync(path.join(root, input), path.join(destination, input), { recursive: true });
}

/** A non-executable PE/CLR envelope for distribution checks, independent of Windows tooling. */
export function artifact(
  root: string,
  directory = path.join(root, 'dist/helpers'),
  kind: Kind = 'private-files'
): void {
  const source = `src/core/platform/${kind.replaceAll('-', '_')}/helper`;
  const digest = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');
  const profile = JSON.parse(
    fs.readFileSync(path.join(root, source, 'toolchain.json'), 'utf8')
  ) as {
    referenceEvidence: string;
    files: Record<string, string>;
  };
  const bytes = Buffer.alloc(1024);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(0x14c, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(224, 148);
  bytes.writeUInt16LE(0x10b, 152);
  bytes.writeUInt32LE(0x2000, 360);
  bytes.writeUInt32LE(0x2000, 388);
  bytes.writeUInt32LE(512, 392);
  bytes.writeUInt32LE(512, 396);
  bytes.writeUInt32LE(1, 528);
  bytes.write(kind, 600, 'ascii');
  const sources: Record<string, string> = {};
  for (const name of ['Program.cs', 'app.manifest', 'toolchain.json'])
    sources[name] = digest(fs.readFileSync(path.join(root, source, name)));
  sources.recipe = digest(fs.readFileSync(path.join(root, `scripts/${kind}-helper.mjs`)));
  sources.sharedRecipe = digest(
    fs.readFileSync(path.join(root, 'scripts/windows-helper-artifacts.mjs'))
  );
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${kind}-v1.exe`), bytes);
  fs.writeFileSync(
    path.join(directory, `${kind}-v1.json`),
    JSON.stringify({
      schema: 1,
      protocol: 1,
      target: 'win32-x64',
      policy: 'development-unsigned',
      framework: '4.8.1',
      referenceEvidence: profile.referenceEvidence,
      sources,
      toolchain: profile.files,
      sha256: digest(bytes)
    })
  );
}
