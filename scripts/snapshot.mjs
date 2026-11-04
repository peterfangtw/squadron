import * as child from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') || key === 'GIT_SSH_COMMAND'
  )
);
const TARGET = process.env.SNAPSHOT_TARGET ?? 'git@github.com:peterfangtw/squadron.git';
const RELEASE_TAG = /^v\d{4}\.\d{1,2}\.\d+$/;

function publish() {
  const args = process.argv.slice(2);
  const plan = args.includes('--plan');
  const selection = args.filter((arg) => arg !== '--plan');
  if (selection.length !== 1 || (selection[0] !== '--latest' && !RELEASE_TAG.test(selection[0]))) {
    throw new Error('use snapshot <vYYYY.WW.N | --latest> [--plan]');
  }
  git(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '--tags']);
  const tag =
    selection[0] === '--latest'
      ? git(['tag', '--list', '--merged', 'origin/main', '--sort=-version:refname'])
          .split('\n')
          .find((name) => RELEASE_TAG.test(name) && provedTree(`refs/tags/${name}`))
      : selection[0];
  if (!tag) {
    console.log('snapshot: no proved stable release tag to publish');
    return;
  }
  const ref = `refs/tags/${tag}`;
  if (!exists(ref)) throw new Error(`no such tag: ${tag}`);
  const sourceTree = provedTree(ref);
  if (!sourceTree) {
    throw new Error(`${tag} has no matching check and smoke result in an annotated release tag`);
  }
  if (!ancestor(ref, 'origin/main')) throw new Error(`${tag} is not on private main yet`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'squadron-snapshot-'));
  try {
    const sourceEnv = { ...ENV, GIT_INDEX_FILE: path.join(scratch, 'source-index') };
    git(['read-tree', sourceTree], ROOT, sourceEnv);
    const excluded = child.execFileSync(
      'git',
      [
        'ls-files',
        '--cached',
        '--ignored',
        `--exclude-from=${path.join(ROOT, '.publicignore')}`,
        '-z'
      ],
      { cwd: ROOT, env: sourceEnv }
    );
    if (excluded.length)
      git(['update-index', '--force-remove', '-z', '--stdin'], ROOT, sourceEnv, excluded);
    const tree = git(['write-tree'], ROOT, sourceEnv);

    const files = path.join(scratch, 'files');
    fs.mkdirSync(files);
    // A tree archive has no source commit or private tag annotation to carry over.
    const archive = child.execFileSync('git', ['archive', tree], {
      cwd: ROOT,
      env: ENV,
      maxBuffer: 64 * 1024 * 1024
    });
    child.execFileSync('tar', ['-xf', '-', '-C', files], { input: archive, env: ENV });
    verifyPrivacy(files);

    const destination = path.join(scratch, 'public.git');
    git(['clone', '--quiet', '--bare', '--no-local', TARGET, destination]);
    const parent = exists('refs/heads/main', destination)
      ? git(['rev-parse', 'refs/heads/main'], destination)
      : undefined;
    const privateCommits = new Set(git(['rev-list', '--all']).split('\n'));
    if (
      git(['rev-list', '--all'], destination)
        .split('\n')
        .some((commit) => privateCommits.has(commit))
    ) {
      throw new Error('destination contains private development history');
    }
    if (exists(ref, destination)) {
      if (
        !parent ||
        !ancestor(ref, parent, destination) ||
        git(['rev-parse', `${ref}^{tree}`], destination) !== tree ||
        git(['log', '-1', '--format=%s', ref], destination) !== `chore: snapshot ${tag}`
      ) {
        throw new Error(`${tag} already names a different snapshot in the destination`);
      }
      console.log(`snapshot: ${tag} already published`);
      return;
    }
    if (parent) {
      const previous = /^chore: snapshot (v\d{4}\.\d{1,2}\.\d+)$/.exec(
        git(['log', '-1', '--format=%s', parent], destination)
      )?.[1];
      if (
        !previous ||
        !exists(`refs/tags/${previous}`) ||
        !ancestor(`refs/tags/${previous}`, ref)
      ) {
        throw new Error(
          'refusing an older checkpoint or an unknown destination head; it could rewind the snapshot'
        );
      }
    } else if (git(['for-each-ref', '--format=%(refname)'], destination)) {
      throw new Error('destination has history but no main branch');
    }
    const report = {
      tag,
      target: TARGET,
      tree,
      parent: parent ?? null,
      excluded: excluded.toString().split('\0').filter(Boolean).length
    };
    if (plan) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const destinationEnv = {
      ...ENV,
      GIT_DIR: destination,
      GIT_WORK_TREE: files,
      GIT_AUTHOR_NAME: 'peterfangtw',
      GIT_AUTHOR_EMAIL: '167056201+peterfangtw@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'peterfangtw',
      GIT_COMMITTER_EMAIL: '167056201+peterfangtw@users.noreply.github.com'
    };
    git(['read-tree', '--empty'], files, destinationEnv);
    // .gitignore must not drop a file that the private tag already tracks.
    git(['add', '--force', '--all'], files, destinationEnv);
    const imported = git(['write-tree'], files, destinationEnv);
    if (imported !== tree) throw new Error('archive did not preserve the filtered source tree');
    const commit = git(
      ['commit-tree', tree, ...(parent ? ['-p', parent] : [])],
      files,
      destinationEnv,
      `chore: snapshot ${tag}\n`
    );
    if (privateCommits.has(commit))
      throw new Error('snapshot commit matches a private development commit');
    git(['update-ref', ref, commit], files, destinationEnv);
    git(
      ['push', '--quiet', '--atomic', TARGET, `${commit}:refs/heads/main`, ref],
      files,
      destinationEnv
    );
    console.log(JSON.stringify({ ...report, commit }, null, 2));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function verifyPrivacy(directory) {
  let names;
  try {
    names = fs
      .readFileSync(path.join(ROOT, 'scripts/local/private_names.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (!names.length) throw new Error();
    names = names.map((name) => new RegExp(name, 'i'));
  } catch {
    throw new Error('privacy check requires a readable, nonempty, valid private denylist');
  }
  if (fs.existsSync(path.join(directory, 'scripts/local'))) {
    throw new Error('privacy check requires scripts/local to be excluded');
  }
  const placeholders = new Set([
    'me',
    'x',
    'someone',
    'u',
    'reader',
    'maya',
    'Test Person',
    'workdir'
  ]);
  const ACCOUNT = String.raw`[A-Za-z0-9][^\\/\s'"\`<>{}$…*%]*`;

  const HOMES = [
    String.raw`\\?/Users\\?/(${ACCOUNT})`,
    String.raw`(?<![\w.])\\?/home\\?/(${ACCOUNT})`,
    String.raw`[A-Za-z]:\\{1,4}Users\\{1,4}(${ACCOUNT}(?: Person)?)`,
    String.raw`%2F(?:Users|home)%2F(${ACCOUNT})`,
    String.raw`-Users-([A-Za-z0-9._]+)-`,
    String.raw`(?<![\w-])-home-([A-Za-z0-9._]+)-`
  ].map((source) => new RegExp(source, 'g'));

  const ACCOUNT_TMP = /\/var\/folders\/[\w+]{2}\/[\w+]{20,}/;
  const inspect = (text) => {
    if (
      names.some((name) => name.test(text)) ||
      ACCOUNT_TMP.test(text) ||
      HOMES.some((shape) => [...text.matchAll(shape)].some((match) => !placeholders.has(match[1])))
    ) {
      // Diagnostics must not repeat the private content into an Actions log.
      throw new Error(
        'privacy check found private names or personal paths in the filtered snapshot'
      );
    }
  };
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      inspect(file);
      const full = path.join(directory, file);
      if (entry.isDirectory()) walk(file);
      else inspect(entry.isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full, 'utf8'));
    }
  };
  walk('');
}

function provedTree(ref) {
  if (git(['cat-file', '-t', ref]) !== 'tag') return undefined;
  const tree = git(['rev-parse', `${ref}^{tree}`]);
  const gates = git(['cat-file', 'tag', ref]).match(/^Gate: check\+smoke [0-9a-f]{40,64}$/gm) ?? [];
  return gates.length === 1 && gates[0] === `Gate: check+smoke ${tree}` ? tree : undefined;
}

function git(args, cwd = ROOT, env = ENV, input) {
  return child
    .execFileSync('git', args, {
      cwd,
      env,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    })
    .trim();
}

function exists(ref, cwd = ROOT) {
  return (
    child.spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd,
      env: ENV,
      stdio: 'ignore'
    }).status === 0
  );
}

function ancestor(older, newer, cwd = ROOT) {
  return (
    child.spawnSync('git', ['merge-base', '--is-ancestor', older, newer], {
      cwd,
      env: ENV,
      stdio: 'ignore'
    }).status === 0
  );
}

try {
  publish();
} catch (error) {
  console.error(`snapshot: ${error.message}`);
  if (error.stderr) console.error(error.stderr.toString().trim());
  process.exitCode = 1;
}
