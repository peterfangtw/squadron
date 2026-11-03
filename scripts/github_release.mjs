import * as child from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--plan') || args.length > 1)
  throw new Error('use node scripts/github_release.mjs [--plan]');

git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main', '--tags']);
const tags = git(['tag', '--list', '--merged', 'origin/main', '--sort=version:refname']);
const eligible = [];
for (const tag of tags.split('\n')) {
  if (!/^v\d{4}\.\d{1,2}\.\d+$/.test(tag) || git(['cat-file', '-t', tag]) !== 'tag') continue;
  const annotation = git(['cat-file', 'tag', tag]);
  const tree = git(['rev-parse', `${tag}^{tree}`]);
  const gates = annotation.match(/^Gate: check\+smoke [0-9a-f]{40,64}$/gm) ?? [];
  if (gates.length !== 1 || gates[0] !== `Gate: check+smoke ${tree}`) continue;
  const notes = annotation
    .slice(annotation.indexOf('\n\n') + 2)
    .replace(gates[0], '')
    .trim();
  eligible.push({ tag, notes });
}

if (!eligible.length) {
  console.log('github-release: no proved stable release on main');
} else {
  const published = run('gh', [
    'api',
    'repos/{owner}/{repo}/releases',
    '--paginate',
    '--jq',
    '.[].tag_name'
  ]).split('\n');
  const boundary = eligible.findLastIndex((release) => published.includes(release.tag));
  const pending = boundary < 0 ? eligible.slice(-1) : eligible.slice(boundary + 1);
  const releases = pending.map(({ tag, notes }) => {
    if (!notes) throw new Error(`${tag} has no release notes`);
    const { version } = JSON.parse(git(['show', `${tag}:package.json`]));
    if (!/^\d+\.\d+\.\d+$/.test(version))
      throw new Error(`${tag} has no numeric extension version`);
    return { tag, title: `v${version}`, notes };
  });
  if (args.includes('--plan')) {
    console.log(JSON.stringify(releases, null, 2));
  } else if (!releases.length) {
    console.log('github-release: all promoted versions already published');
  } else {
    for (const [index, release] of releases.entries()) {
      console.log(
        run(
          'gh',
          [
            'release',
            'create',
            release.tag,
            '--verify-tag',
            index === releases.length - 1 ? '--latest' : '--latest=false',
            '--title',
            release.title,
            '--notes-file',
            '-'
          ],
          release.notes
        )
      );
    }
  }
}

function git(argv) {
  return run('git', argv);
}

function run(command, argv, input) {
  return child
    .execFileSync(command, argv, {
      cwd: ROOT,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit']
    })
    .trim();
}
