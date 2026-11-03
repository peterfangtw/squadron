import * as cp from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const HELPERS = [
  {
    id: 'private-files',
    source: 'src/core/platform/private_files/helper',
    name: 'private-files-v1',
    recipe: 'scripts/private-files-helper.mjs',
    prefix: 'SQUADRON_PRIVATE_FILES',
    references: ['mscorlib.dll', 'System.dll', 'System.Core.dll'],
    define: '__SQUADRON_PRIVATE_FILES_SHA256__'
  },
  {
    id: 'console-login',
    source: 'src/core/platform/console_login/helper',
    name: 'console-login-v1',
    recipe: 'scripts/console-login-helper.mjs',
    prefix: 'SQUADRON_CONSOLE_LOGIN',
    references: ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'],
    define: '__SQUADRON_CONSOLE_LOGIN_SHA256__'
  }
];
export const RECIPE = 'scripts/windows-helper-artifacts.mjs';
const INPUTS = ['Program.cs', 'app.manifest', 'toolchain.json'];
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function sources(helper, root) {
  const hashes = Object.fromEntries(
    INPUTS.map((name) => [name, sha(fs.readFileSync(path.join(root, helper.source, name)))])
  );
  hashes.recipe = sha(fs.readFileSync(path.join(root, helper.recipe)));
  hashes.sharedRecipe = sha(fs.readFileSync(path.join(root, RECIPE)));
  return hashes;
}

export function stagingBuild(root) {
  const file = path.join(root, 'package.json');
  return (
    fs.existsSync(file) &&
    JSON.parse(fs.readFileSync(file, 'utf8')).squadronBuild === 'posix-staging'
  );
}

export function verifyBuild(helper, root, directory = path.join(root, 'dist/helpers')) {
  if (
    stagingBuild(root) &&
    !fs.existsSync(path.join(directory, `${helper.name}.exe`)) &&
    !fs.existsSync(path.join(directory, `${helper.name}.json`))
  )
    return;
  return verify(helper, root, directory);
}

export function verify(helper, root, directory = path.join(root, 'dist/helpers')) {
  const manifestFile = path.join(directory, `${helper.name}.json`);
  if (fs.statSync(manifestFile).size > 16384)
    throw new Error(`${helper.id} manifest exceeds limit`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const profile = JSON.parse(
    fs.readFileSync(path.join(root, helper.source, 'toolchain.json'), 'utf8')
  );
  const expected = sources(helper, root);
  if (
    manifest.schema !== 1 ||
    manifest.protocol !== 1 ||
    manifest.target !== 'win32-x64' ||
    manifest.policy !== 'development-unsigned' ||
    manifest.framework !== '4.8.1' ||
    manifest.referenceEvidence !== profile.referenceEvidence ||
    JSON.stringify(manifest.sources) !== JSON.stringify(expected) ||
    JSON.stringify(manifest.toolchain) !== JSON.stringify(profile.files) ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')
  )
    throw new Error(`${helper.id} source, toolchain or protocol mismatch`);
  const exe = fs.readFileSync(path.join(directory, `${helper.name}.exe`));
  if (exe.length > 1048576 || exe.length < 512 || sha(exe) !== manifest.sha256)
    throw new Error(`${helper.id} artifact digest mismatch`);
  const pe = exe.readUInt32LE(60);
  if (exe.readUInt16LE(0) !== 0x5a4d || pe > exe.length - 256 || exe.readUInt32LE(pe) !== 0x4550)
    throw new Error(`${helper.id} artifact is not a PE`);
  // CLR header flags: IL-only, no 32-bit requirement or preference; PE32/AnyCPU.
  const optional = pe + 24;
  if (exe.readUInt16LE(optional) !== 0x10b || exe.readUInt16LE(pe + 4) !== 0x14c)
    throw new Error(`${helper.id} artifact architecture mismatch`);
  const sections = exe.readUInt16LE(pe + 6),
    table = optional + exe.readUInt16LE(pe + 20);
  const clrRva = exe.readUInt32LE(optional + 208);
  let flags;
  for (let i = 0; i < sections && table + (i + 1) * 40 <= exe.length; i++) {
    const at = table + i * 40,
      rva = exe.readUInt32LE(at + 12),
      size = exe.readUInt32LE(at + 16);
    if (clrRva >= rva && clrRva + 20 <= rva + size) {
      const offset = exe.readUInt32LE(at + 20) + clrRva - rva;
      if (offset + 20 <= exe.length) flags = exe.readUInt32LE(offset + 16);
    }
  }
  if (flags === undefined || (flags & 1) === 0 || (flags & 0x20002) !== 0)
    throw new Error(`${helper.id} CLR architecture mismatch`);
  return manifest;
}

// Archive children receive absolute inputs from their originating checkout.
export function buildEnvironment(helper, root, environment = process.env) {
  const result = { [`${helper.prefix}_REQUIRED`]: '1' };
  for (const key of [
    `${helper.prefix}_INPUT`,
    `${helper.prefix}_REFERENCES`,
    `${helper.prefix}_TOOLCHAIN`
  ]) {
    if (environment[key]) result[key] = path.resolve(root, environment[key]);
  }
  if (environment[`${helper.prefix}_INPUT_MANIFEST_SHA256`])
    result[`${helper.prefix}_INPUT_MANIFEST_SHA256`] =
      environment[`${helper.prefix}_INPUT_MANIFEST_SHA256`];
  if (!result[`${helper.prefix}_INPUT`] && !result[`${helper.prefix}_REFERENCES`]) {
    try {
      const common = cp
        .execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        })
        .trim();
      result[`${helper.prefix}_REFERENCES`] = path.resolve(
        root,
        common,
        'squadron-helper-toolchains/net48-1.0.3'
      );
    } catch {
      // An archive has no Git metadata; its caller supplies the build inputs.
    }
  }
  return result;
}

export function prepare(helper, root = ROOT, { required = true } = {}) {
  const destination = path.join(root, 'dist/helpers');
  const environment = buildEnvironment(helper, root);
  const input = environment[`${helper.prefix}_INPUT`];
  if (input) {
    if (
      sha(fs.readFileSync(path.join(input, `${helper.name}.json`))) !==
      environment[`${helper.prefix}_INPUT_MANIFEST_SHA256`]
    )
      throw new Error(`${helper.id} imported manifest needs an independently supplied SHA-256 pin`);
    verify(helper, root, path.resolve(input));
    fs.mkdirSync(destination, { recursive: true });
    for (const suffix of ['exe', 'json'])
      if (path.resolve(input) !== destination)
        fs.copyFileSync(
          path.join(input, `${helper.name}.${suffix}`),
          path.join(destination, `${helper.name}.${suffix}`)
        );
    if (
      sha(fs.readFileSync(path.join(destination, `${helper.name}.json`))) !==
      environment[`${helper.prefix}_INPUT_MANIFEST_SHA256`]
    )
      throw new Error(`${helper.id} imported manifest changed while copying`);
    return verify(helper, root, destination);
  }
  try {
    return verify(helper, root, destination);
  } catch {
    /* Rebuild or import only from verified source inputs. */
  }
  if (!required && process.platform !== 'win32') {
    for (const suffix of ['exe', 'json'])
      fs.rmSync(path.join(destination, `${helper.name}.${suffix}`), { force: true });
    return undefined;
  }
  if (process.platform !== 'win32')
    throw new Error(
      `${helper.id} requires same-source verified Windows build input (${helper.prefix}_INPUT)`
    );
  const toolchain =
    environment[`${helper.prefix}_TOOLCHAIN`] ??
    path.join(process.env.SystemRoot ?? '', 'Microsoft.NET/Framework64/v4.0.30319');
  const profile = JSON.parse(
    fs.readFileSync(path.join(root, helper.source, 'toolchain.json'), 'utf8')
  );
  const references = environment[`${helper.prefix}_REFERENCES`];
  if (!references)
    throw new Error(
      `${helper.id} build requires ${helper.prefix}_REFERENCES or a pinned imported artifact`
    );
  for (const [name, digest] of Object.entries(profile.files)) {
    if (
      sha(fs.readFileSync(path.join(name === 'csc.exe' ? toolchain : references, name))) !== digest
    )
      throw new Error(`${helper.id} pinned toolchain mismatch: ${name}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  const executable = path.join(destination, `${helper.name}.exe`);
  const arguments_ = [
    '/nologo',
    '/noconfig',
    '/nostdlib+',
    '/optimize+',
    '/target:exe',
    '/platform:anycpu',
    ...helper.references.map((name) => `/reference:${path.join(references, name)}`),
    `/win32manifest:${path.join(root, helper.source, 'app.manifest')}`,
    `/out:${executable}`,
    path.join(root, helper.source, 'Program.cs')
  ];
  cp.execFileSync(path.join(toolchain, 'csc.exe'), arguments_, {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 65536,
    stdio: 'pipe'
  });
  const manifest = {
    schema: 1,
    protocol: 1,
    target: 'win32-x64',
    framework: '4.8.1',
    policy: 'development-unsigned',
    referenceEvidence: profile.referenceEvidence,
    referencePackage: profile.referencePackage,
    sources: sources(helper, root),
    toolchain: profile.files,
    command: arguments_.map((arg) =>
      arg
        .replaceAll(references, '<net48-references>')
        .replaceAll(root, '<source>')
        .replaceAll(toolchain, '<toolchain>')
    ),
    sha256: sha(fs.readFileSync(executable))
  };
  fs.writeFileSync(
    path.join(destination, `${helper.name}.json`),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  return verify(helper, root, destination);
}
