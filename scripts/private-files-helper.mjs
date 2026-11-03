import * as path from 'node:path';
import * as url from 'node:url';
import * as artifacts from './windows-helper-artifacts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HELPER = artifacts.HELPERS[0];

export const sources = (root) => artifacts.sources(HELPER, root);
export const verify = (root, directory) => artifacts.verify(HELPER, root, directory);
export const verifyBuild = (root, directory) => artifacts.verifyBuild(HELPER, root, directory);
export const buildEnvironment = (root, environment) =>
  artifacts.buildEnvironment(HELPER, root, environment);
export const prepare = (root, options) => artifacts.prepare(HELPER, root, options);
export const stagingBuild = artifacts.stagingBuild;

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? 'build';
  if (!['build', 'verify', 'public'].includes(mode))
    throw new Error('use private-files-helper.mjs build|verify|public');
  const manifest = mode === 'build' ? prepare() : verify(ROOT);
  console.log(
    JSON.stringify({
      protocol: manifest.protocol,
      target: manifest.target,
      sha256: manifest.sha256,
      referenceEvidence: manifest.referenceEvidence
    })
  );
}
