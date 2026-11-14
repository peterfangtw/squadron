import { FLAGS as ROUTINE_FLAGS } from '../../cli/routine';
import * as platform from '../../core/platform';
import * as win32 from '../../core/platform/files/win32';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  SKILL_FILES,
  SKILL_NAME,
  decide,
  installSkill,
  normaliseBody,
  readInstalledText,
  skillPaths,
  skillStatus,
  skillTarget,
  stampLine
} from '../../core/skill_install';
import { FLAGS as ANSWER_FLAGS } from '../../cli/answer';
import { FLAGS as ATTACH_FLAGS } from '../../cli/attach';
import { FLAGS as FETCH_FLAGS } from '../../cli/fetch';
import { FLAGS as LIST_FLAGS } from '../../cli/list';
import { FLAGS as MODEL_FLAGS } from '../../cli/models';
import { FLAGS as RENAME_FLAGS } from '../../cli/rename';
import { FLAGS as WARM_FLAGS } from '../../cli/warm';
import { FLAGS as SEND_FLAGS } from '../../cli/send';
import { FLAGS as SPAWN_FLAGS } from '../../cli/spawn';
import { FLAGS as STEP_FLAGS } from '../../cli/step';
import { FLAGS as END_FLAGS } from '../../cli/end';
import { FLAGS as WAIT_FLAGS } from '../../cli/wait';
import { CLAUDE_SKILLS_DIR, SHIM_NAMES } from '../../core/paths';
import { adapter } from '../../core/adapter';
import { claudeAdapter } from '../../core/claude/adapter';
import { BRANDS } from '../../core/brands';
import { linkDir, modeBitsSkip, needsFileSymlinks, repoRoot } from '../helpers';

/**
 * The contract is that exactly one class of file is ever overwritten — one we
 * wrote, unedited, from this version or older. Everything else on disk survives
 * untouched, and the symlink cases assert that by reading the *target* back.
 *
 * Run against a real temp `home`; the module takes one, so no HOME juggling.
 */

let root: string;
let home: string;
let source: string;

const OURS = '2026.34.15';

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-skill-'));
  source = path.join(root, 'SKILL.source.md');
  // Trailing spaces on a body line on purpose: the cosmetic-save case below is
  // about an editor stripping them, and a fixture with none to strip tests
  // nothing. (It had none, and the test passed anyway.)
  await fs.writeFile(source, '---\nname: squadron\n---\n\nThe document.   \nA line.\n');
});
after(() => fs.rm(root, { recursive: true, force: true }));

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(root, 'home-'));
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
});

const dest = (): string => skillPaths('.claude', home).file;
const read = (): Promise<string> => fs.readFile(dest(), 'utf8');
const put = async (text: string): Promise<void> => {
  await fs.mkdir(path.dirname(dest()), { recursive: true });
  await fs.writeFile(dest(), text);
};
/** A file that passes the ownership test, at whatever version and body. */
const ourFile = (body: string, version: string): string => `${body}${stampLine(body, version)}\n`;

describe('installSkill', () => {
  it('writes when the file is absent, and stamps what it wrote', async (context) => {
    let attempts = 0;
    const backend = win32.files({
      open: () => {
        throw new Error('unexpected directory open');
      },
      rename: (source, destination) => {
        attempts++;
        return fs.rename(source, destination);
      }
    });
    context.mock.method(platform.files, 'replace', async (source: string, destination: string) => {
      await backend.replace(source, destination);
    });

    assert.equal(await installSkill(source, OURS, '.claude', home), 'written');
    const text = await read();
    assert.equal(readInstalledText(text).kind, 'ours');
    assert.match(text, /^<!-- squadron 2026\.34\.15 [0-9a-f]{64} -->$/m);
    assert.match(text, /The document\./);
    assert.equal(attempts, 1);
  });

  it('is a no-op the second time', async () => {
    await installSkill(source, OURS, '.claude', home);
    const first = await read();
    assert.equal(await installSkill(source, OURS, '.claude', home), 'current');
    assert.equal(await read(), first);
  });

  it('overwrites its own older version', async () => {
    await put(ourFile('old text\n', '2026.30.1'));
    assert.equal(await installSkill(source, OURS, '.claude', home), 'written');
    assert.match(await read(), /The document\./);
  });

  it('leaves a file written by a newer build', async () => {
    const newer = ourFile('from the future\n', '2026.40.1');
    await put(newer);
    assert.equal(await installSkill(source, OURS, '.claude', home), 'left-newer');
    assert.equal(await read(), newer);
  });

  it('leaves a file with no stamp', async () => {
    await put('someone else entirely\n');
    assert.equal(await installSkill(source, OURS, '.claude', home), 'left-foreign');
    assert.equal(await read(), 'someone else entirely\n');
  });

  it('leaves a stamped file whose body was edited', async () => {
    const edited = `${ourFile('body\n', OURS).replace('body', 'body, changed')}`;
    await put(edited);
    assert.equal(await installSkill(source, OURS, '.claude', home), 'left-foreign');
    assert.equal(await read(), edited);
  });

  it('leaves a file whose stamp version will not parse', async () => {
    // NaN comparisons are all false, so an unguarded compare answers "not newer"
    // and overwrites the one input that exists to make us back off.
    //
    // The hash must be the *correct* one for the body, or the file is foreign by
    // the hash check too and this proves nothing about the version. It did not
    // discriminate before: `parseVersion` could have returned `[2026, 35, NaN]`
    // and the test would still have passed.
    const body = 'body\n';
    const junk = `${body}${stampLine(body, '2026.35.0-rc1')}\n`;
    await put(junk);
    assert.equal(await installSkill(source, OURS, '.claude', home), 'left-foreign');
    assert.equal(await read(), junk);
  });

  it('survives a cosmetic save that strips trailing whitespace', async () => {
    await installSkill(source, OURS, '.claude', home);
    const before = await read();
    assert.match(before, /[ \t]+\n/, 'the fixture has no trailing whitespace to strip');
    const saved = before.replace(/[ \t]+$/gm, '');
    await fs.writeFile(dest(), saved);
    // Still ours: the hash is over a normalised body, so the editor's tidy-up
    // does not cost the reader every future upgrade.
    assert.notEqual(saved, before);
    assert.equal(readInstalledText(saved).kind, 'ours');
    assert.equal(await installSkill(source, OURS, '.claude', home), 'current');
  });

  it('survives a save that rewrites every line ending to CRLF', async () => {
    // `files.eol: auto` is `\r\n` on Windows, so this is what "opened it and
    // saved" means there. `\r` is not whitespace to the strip above it.
    await installSkill(source, OURS, '.claude', home);
    const saved = (await read()).replace(/\n/g, '\r\n');
    await fs.writeFile(dest(), saved);
    assert.equal(readInstalledText(saved).kind, 'ours');
    assert.equal(await installSkill(source, OURS, '.claude', home), 'current');
  });

  it('leaves a file it cannot read rather than replacing it', async () => {
    // The write is a rename into the parent directory, which needs no permission
    // on the file it replaces — so treating an unreadable file as absent means
    // destroying it. Only ENOENT is absent.
    await put('mode 000, and not ours\n');
    await fs.chmod(dest(), 0o000);
    try {
      assert.equal(await installSkill(source, OURS, '.claude', home), 'left-foreign');
    } finally {
      await fs.chmod(dest(), 0o644);
    }
    assert.equal(await read(), 'mode 000, and not ours\n');
  });

  it(
    'refuses a symlinked SKILL.md instead of renaming the link away',
    { skip: needsFileSymlinks() },
    async () => {
      // `rename(2)` does not follow a final-component symlink, so the target is
      // safe — but the link itself is replaced, and the reader's file is orphaned
      // where they will not notice.
      const outside = path.join(root, `file-${path.basename(home)}`);
      await fs.mkdir(outside, { recursive: true });
      const target = path.join(outside, 'SKILL.md');
      await fs.writeFile(target, ourFile('theirs\n', '2026.30.1'));
      await fs.mkdir(path.dirname(dest()), { recursive: true });
      await fs.symlink(target, dest());

      assert.equal(await installSkill(source, OURS, '.claude', home), 'unsafe-path');
      assert.equal((await fs.lstat(dest())).isSymbolicLink(), true);
      assert.equal(await fs.readFile(target, 'utf8'), ourFile('theirs\n', '2026.30.1'));
    }
  );

  it('reports failure for a source it cannot read, and writes nothing', async () => {
    assert.equal(
      await installSkill(path.join(root, 'no-such-file.md'), OURS, '.claude', home),
      'failed'
    );
    assert.equal(
      await fs.stat(dest()).then(
        () => true,
        () => false
      ),
      false
    );
  });

  it('refuses a version of its own that will not parse', async () => {
    assert.equal(await installSkill(source, '2026.35.0-rc1', '.claude', home), 'failed');
  });

  it('does nothing at all without ~/.claude', async () => {
    await fs.rm(path.join(home, '.claude'), { recursive: true, force: true });
    assert.equal(await installSkill(source, OURS, '.claude', home), 'no-cli-dir');
    assert.equal(
      await fs.stat(path.join(home, '.claude')).then(
        () => true,
        () => false
      ),
      false
    );
  });

  it('writes under the CLI directory it is given, and only that one', async () => {
    await fs.mkdir(path.join(home, '.codex'));
    assert.equal(await installSkill(source, OURS, '.codex', home), 'written');
    assert.equal(
      readInstalledText(await fs.readFile(skillPaths('.codex', home).file, 'utf8')).kind,
      'ours'
    );
    // `.claude` exists in this home too and was not the one asked for.
    assert.equal(
      await fs.stat(path.join(home, '.claude', 'skills')).then(
        () => true,
        () => false
      ),
      false
    );
  });

  it('sweeps a leftover temp from a crashed write', async () => {
    await fs.mkdir(path.dirname(dest()), { recursive: true });
    // Six digits, because `sweepTemps` leaves a temp whose pid is still alive
    // and 999 is not a pid nobody has: it was a live `claude` here on
    // 2026-09-22, and a macOS ScreenTime helper an hour later. macOS wraps pids
    // at 99999 (`kern.maxproc`), so this one can only ever answer `ESRCH`.
    const stale = path.join(path.dirname(dest()), 'SKILL.md.999999.0.tmp');
    await fs.writeFile(stale, 'half a document');
    assert.equal(await installSkill(source, OURS, '.claude', home), 'written');
    assert.deepEqual(await fs.readdir(path.dirname(dest())), ['SKILL.md']);
  });
});

describe('installSkill: two builds at one version', () => {
  /**
   * The claim the whole tie-break exists for, and the one worth a regression
   * test: two installs of the same version holding different text must reach a
   * fixed point rather than rewriting each other on every activation. The
   * `decide` unit test below proves the two branches differ; it cannot prove the
   * pair settles.
   */
  it('converges on one file instead of alternating', async () => {
    const other = path.join(root, `other-${path.basename(home)}.md`);
    await fs.writeFile(other, '---\nname: squadron\n---\n\nA different document.\n');

    await installSkill(source, OURS, '.claude', home);
    await installSkill(other, OURS, '.claude', home);
    const settled = await read();

    for (let round = 0; round < 3; round++) {
      const a = await installSkill(source, OURS, '.claude', home);
      const b = await installSkill(other, OURS, '.claude', home);
      assert.equal(await read(), settled, `the file moved on round ${round}`);
      assert.ok(
        [a, b].every((o) => o === 'current' || o === 'left-tie'),
        `a round still wrote: ${a}, ${b}`
      );
    }
    // And the winner is the lower hash rather than whoever went last.
    assert.equal(readInstalledText(settled).kind, 'ours');
  });

  it('does not call a lost mkdir race a symlink', async () => {
    // Six callers against a home with no `skills` directory yet: one creates it
    // and the rest get EEXIST. Reporting that as `unsafe-path` sent a reader
    // hunting for a symlink that was never there.
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => installSkill(source, OURS, '.claude', home))
    );
    assert.equal(
      outcomes.filter((o) => o === 'unsafe-path').length,
      0,
      `a benign race reported unsafe-path: ${outcomes.join(', ')}`
    );
    assert.ok(outcomes.includes('written'), `nobody installed: ${outcomes.join(', ')}`);
    assert.equal(readInstalledText(await read()).kind, 'ours');
  });
});

describe('installSkill: symlinks', () => {
  it('refuses when the skill directory is a link, and does not touch its target', async () => {
    const outside = path.join(root, `repo-${path.basename(home)}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'SKILL.md'), 'the user own file\n');
    await fs.mkdir(path.join(home, '.claude', 'skills'), { recursive: true });
    await linkDir(outside, path.join(home, '.claude', 'skills', SKILL_NAME));

    assert.equal(await installSkill(source, OURS, '.claude', home), 'unsafe-path');
    assert.equal(await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8'), 'the user own file\n');
  });

  it('refuses when ~/.claude itself is a link, which the existence check follows', async () => {
    // `fs.stat` resolves the link and reports a directory, so the "is the CLI
    // installed" gate cannot be the thing that catches this.
    const outside = path.join(root, `dotclaude-${path.basename(home)}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(home, '.claude'), { recursive: true, force: true });
    await linkDir(outside, path.join(home, '.claude'));

    assert.equal(await installSkill(source, OURS, '.claude', home), 'unsafe-path');
    assert.deepEqual(await fs.readdir(outside), []);
  });

  it('refuses when a link sits two components up, where an lstat on the file would miss it', async () => {
    // The case the first draft of the plan got wrong: symlinking `skills`
    // wholesale is ordinary dotfile practice, and then nothing about the
    // destination file or its own directory looks like a link.
    const outside = path.join(root, `skills-${path.basename(home)}`);
    await fs.mkdir(outside, { recursive: true });
    await linkDir(outside, path.join(home, '.claude', 'skills'));

    assert.equal(await installSkill(source, OURS, '.claude', home), 'unsafe-path');
    assert.deepEqual(await fs.readdir(outside), []);
  });
});

describe('decide', () => {
  const hash = (n: string) => n.repeat(64).slice(0, 64);
  const ours = [2026, 34, 15];

  it('writes on absent, leaves on foreign', () => {
    assert.equal(decide({ kind: 'absent' }, ours, hash('a')), 'write');
    assert.equal(decide({ kind: 'foreign' }, ours, hash('a')), 'left-foreign');
  });

  it('treats a missing trailing part as zero', () => {
    // The hashes are ordered so the tie-break would answer `left-tie`. With them
    // the other way round this passed whether `compareVersion` worked or not,
    // because the tie-break returns `write` for a lower hash too.
    const disk = { kind: 'ours' as const, version: [2026, 34], hash: hash('a') };
    assert.equal(decide(disk, ours, hash('b')), 'write');
  });

  it('breaks a same-version tie the same way from both sides', () => {
    const low = hash('1');
    const high = hash('e');
    const disk = { kind: 'ours' as const, version: ours, hash: high };
    // The build holding the lower hash writes; the other stands down. Whichever
    // order the two windows activate in, they converge on the same file.
    assert.equal(decide(disk, ours, low), 'write');
    assert.equal(decide({ ...disk, hash: low }, ours, high), 'left-tie');
  });
});

/**
 * The skill spent a fortnight telling agents that `send` and `list` had no
 * binary while both shipped, because the only copy of the document lived
 * outside the repo and nothing compared it to anything. Now it ships from
 * `install/`, so a test can read the artefact itself.
 */
const shipped = path.join(repoRoot(), 'install', 'skills', 'squadron', 'SKILL.md');

describe('the shipped skill documents every shim', () => {
  it('gives every shim a usage line in its own section', async () => {
    // **A usage line, not a mention.** A whole-file scan cannot see the drift
    // this exists for: the frontmatter and the prose name the verbs, so deleting
    // the one line that says how to run one — the fortnight-long bug, a verb the
    // document never tells an agent about — left the weaker assertion below
    // green. Verified by deleting one.
    const text = await fs.readFile(shipped, 'utf8');
    const usage = new Map(
      text
        .split(/^## /m)
        .slice(1)
        .map((part) => [
          (part.split('\n')[0] ?? '').trim(),
          new Set([...part.matchAll(/^~\/\.squadron\/bin\/(squadron-[a-z-]+)/gm)].map((m) => m[1]))
        ])
    );
    const missing = SHIM_NAMES.filter(
      (shim) => !usage.get(shim.replace(/^squadron-/, ''))?.has(shim)
    );
    assert.deepEqual(missing, []);
  });

  it('names no verb the extension does not install', async () => {
    // A sibling skill's name is spelled like a verb and is not one.
    const skills = new Set<string>(SKILL_FILES.map((asset) => asset.skill));
    const text = await fs.readFile(shipped, 'utf8');
    const named = new Set(
      (text.match(/squadron(?:-[a-z]+)+/g) ?? []).filter((name) => !skills.has(name))
    );
    assert.deepEqual([...named].sort(), [...SHIM_NAMES].sort());
  });

  it('gives Windows PowerShell and cmd the .cmd launcher, never the extensionless file', async () => {
    // Codex and Grok tool commands ran in Windows PowerShell (2026-10-25). The
    // extensionless path there opens Windows' "How do you want to open" dialog.
    const text = await fs.readFile(shipped, 'utf8');
    const running = text.split(/^## /m).find((part) => part.startsWith('Running a verb\n')) ?? '';
    assert.ok(running.includes('`~/.squadron/bin/squadron-rename --name '), running);
    assert.ok(
      running.includes('`& "$HOME\\.squadron\\bin\\squadron-rename.cmd" --name \'"'),
      running
    );
    assert.ok(
      running.includes('`"%USERPROFILE%\\.squadron\\bin\\squadron-rename.cmd" --name "'),
      running
    );
    const native = [...text.matchAll(/\\\.squadron\\bin\\([\w-]+(?:\.\w+)?)/g)].map((m) => m[1]);
    assert.ok(native.length > 0);
    assert.deepEqual(
      native.filter((name) => !name?.endsWith('.cmd')),
      []
    );
    assert.doesNotMatch(text, /native launcher invocation depends on the shell/);
    assert.match(running, /delayed expansion\s+must be off in the calling shell/i);
    assert.match(running, /setlocal.*cannot undo caller expansion/);
  });
});

/**
 * A flag drifts the way a verb name used to, and costs the same turn: the
 * document spells `--tags`, `parseFlags` was never told about it, and the agent
 * lands on exit 1 holding a usage line it believes it is already obeying. An
 * undeclared flag is a hard error there by design, so each CLI's `FLAGS` is the
 * only spelling that gets to be right — which makes it the thing to compare the
 * prose against.
 */
describe('the shipped skill documents every flag', () => {
  /** One entry per verb, `FLAGS` straight off the module that parses it. */
  const SECTIONS = [
    ['list', LIST_FLAGS],
    ['models', MODEL_FLAGS],
    ['send', SEND_FLAGS],
    ['answer', ANSWER_FLAGS],
    ['attach', ATTACH_FLAGS],
    ['fetch-file', FETCH_FLAGS],
    ['wait', WAIT_FLAGS],
    ['rename', RENAME_FLAGS],
    ['warm', WARM_FLAGS],
    ['spawn', SPAWN_FLAGS],
    ['end', END_FLAGS],
    ['step', STEP_FLAGS],
    ['routine', ROUTINE_FLAGS]
  ] as const;

  /**
   * `--caller-session-id` is left out of most sections on purpose. It is plumbing — every
   * verb defaults it from the environment — and the document names it twice,
   * where an agent has a reason to reach for it: as the field `squadron-list`
   * prints, and as `squadron-step`'s recovery move when a leaked session id
   * makes a run unfindable. Documenting it seven times would invite six wrong
   * uses to save none.
   */
  const PLUMBING = new Set(['caller-session-id']);

  /** Named in the prose and not ours: the child CLI's own flag, in the sentence
   *  about what `skipPermissions.enabled` starts a session with. */
  const FOREIGN = new Set(['dangerously-skip-permissions']);

  /**
   * The `[a-z]` after the dashes is doing real work: a Markdown table rule is
   * `| ---- | ------- |`, and a looser class reads each cell as a flag named
   * `----`. Two of those rules are in the file today — the exit-code table and
   * the `list` field table — and the noise from them would fail both tests
   * below on every run.
   */
  const flagsIn = (text: string): string[] => [
    ...new Set((text.match(/--[a-z][a-z-]*/g) ?? []).map((flag) => flag.slice(2)))
  ];

  /** Keyed by heading, lowercased; the body runs to the next `##`. */
  const sections = (text: string): Map<string, string> =>
    new Map(
      text
        .split(/^## /m)
        .slice(1)
        .map((part) => [(part.split('\n')[0] ?? '').trim().toLowerCase(), part])
    );

  it('has a section listed here for every shim', () => {
    // Otherwise an eighth verb ships with its flags checked by nothing, which is
    // the exact shape of the bug the block above exists for.
    assert.deepEqual(SECTIONS.map(([verb]) => `squadron-${verb}`).sort(), [...SHIM_NAMES].sort());
  });

  it('spells every flag a verb takes in the section for that verb', async () => {
    const bodies = sections(await fs.readFile(shipped, 'utf8'));
    // Collected across every verb and asserted once, rather than asserted inside
    // the loop. Measured: deleting `--interrupt` from `send` and `--ticket` from
    // `spawn` in one edit reported only `send`, because the first assertion
    // throws out of the loop — so a reader fixes one flag, re-runs, and is told
    // about the next.
    const missing = SECTIONS.flatMap(([verb, flags]) => {
      const body = bodies.get(verb);
      if (body === undefined) {
        return [`no '## ${verb}' section — a heading was renamed`];
      }
      const spelled = new Set(flagsIn(body));
      return flags
        .filter((flag) => !PLUMBING.has(flag) && !spelled.has(flag))
        .map((flag) => `${verb} takes --${flag}, and its section never names it`);
    });
    assert.deepEqual(missing, []);
  });

  it('names only declared flags or the rejected help probe', async () => {
    // File-wide rather than per-section, because a section legitimately points
    // at another verb's flag — `list` explains what `--parent-session-id` takes, `rename`
    // says it has no `--pid`. Scoped per-section those read as drift; scoped to
    // the file, a renamed or deleted flag still has nowhere to hide.
    const declared = new Set<string>(SECTIONS.flatMap(([, flags]) => [...flags]));
    // `--help` and `--argv-file` are read by every verb before its own flags.
    const prelude = new Set(['help', 'argv-file']);
    const stray = flagsIn(await fs.readFile(shipped, 'utf8')).filter(
      (flag) => !prelude.has(flag) && !declared.has(flag) && !FOREIGN.has(flag)
    );
    assert.deepEqual(stray, [], 'the skill spells a flag no CLI declares');
  });
});

describe('paths and normalisation', () => {
  it('agrees with the constant in paths.ts', () => {
    const root = claudeAdapter.skillRoot(os.homedir(), process.env);
    assert.equal(skillPaths(...skillTarget(root)).dir, path.join(CLAUDE_SKILLS_DIR, SKILL_NAME));
  });

  /** One copy per CLI rests on this: Codex lists a name found in two of its
   *  roots twice, so two brands sharing a root, or one writing `.agents`,
   *  would put a duplicate in front of it (`CliAdapter.skillRoot`). */
  it('gives every brand a skill root of its own, none of them shared', () => {
    const roots = BRANDS.map((brand) => adapter(brand)?.skillRoot(home, {}));
    assert.deepEqual(
      roots,
      ['.claude', '.grok', '.codex'].map((name) => path.join(home, name))
    );
    assert.equal(new Set(roots).size, BRANDS.length);
  });

  it('installs into a moved Claude root, wherever it is', async () => {
    const root = path.join(home, 'elsewhere', 'claude-config');
    await fs.mkdir(root, { recursive: true });
    const target = skillTarget(claudeAdapter.skillRoot(home, { CLAUDE_CONFIG_DIR: root }));
    assert.equal(await installSkill(source, OURS, ...target), 'written');
    assert.equal(await skillStatus(...target), 'installed');
    assert.equal(
      path.dirname(path.dirname(path.dirname(skillPaths(...target).file))),
      root,
      'the file sits at <root>/skills/<name>/SKILL.md'
    );
  });

  it('keeps Codex and Grok at the home however Claude moved', () => {
    const env = { CLAUDE_CONFIG_DIR: path.join(home, 'elsewhere') };
    assert.equal(adapter('codex')?.skillRoot(home, env), path.join(home, '.codex'));
    assert.equal(adapter('grok')?.skillRoot(home, env), path.join(home, '.grok'));
  });

  it('collapses trailing whitespace and blank lines, and nothing else', () => {
    assert.equal(normaliseBody('a  \nb\t\n\n\n'), 'a\nb\n');
    assert.equal(normaliseBody('a'), 'a\n');
    assert.equal(normaliseBody('a  b\n'), 'a  b\n');
  });

  it('folds CRLF, which is what a save on Windows does to every line', () => {
    assert.equal(normaliseBody('a\r\nb\r\n'), 'a\nb\n');
    assert.equal(normaliseBody('a  \r\n\r\n'), 'a\n');
  });
});

describe('skillStatus', () => {
  it('leaves out a CLI with no directory here', async () => {
    assert.equal(await skillStatus('.codex', home), undefined);
  });

  it('is missing until the installer writes, then installed', async () => {
    assert.equal(await skillStatus('.claude', home), 'missing');
    await installSkill(source, OURS, '.claude', home);
    assert.equal(await skillStatus('.claude', home), 'installed');
  });

  it('calls an older stamp of ours installed', async () => {
    await put(ourFile('old body\n', '2026.30.1'));
    assert.equal(await skillStatus('.claude', home), 'installed');
  });

  it('calls a file we did not write, or one edited since, foreign', async () => {
    await put('---\nname: squadron\n---\nmine\n');
    assert.equal(await skillStatus('.claude', home), 'foreign');
    await put(`${ourFile('body\n', OURS)}edited\n`);
    assert.equal(await skillStatus('.claude', home), 'foreign');
  });

  it('calls a file it cannot read foreign', { skip: modeBitsSkip }, async (t) => {
    if (process.getuid?.() === 0) return t.skip('env: root reads a mode-000 file');
    await put(ourFile('body\n', OURS));
    await fs.chmod(dest(), 0o000);
    t.after(() => fs.chmod(dest(), 0o644));
    assert.equal(await skillStatus('.claude', home), 'foreign');
  });

  it('calls any link the installer refuses foreign, even to a stamped file', async () => {
    const outside = path.join(root, `status-${path.basename(home)}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'SKILL.md'), ourFile('body\n', OURS));
    await fs.mkdir(path.join(home, '.claude', 'skills'), { recursive: true });
    await linkDir(outside, path.join(home, '.claude', 'skills', SKILL_NAME));
    assert.equal(await skillStatus('.claude', home), 'foreign');
  });

  it(
    'calls a dangling link to SKILL.md foreign, not missing',
    { skip: needsFileSymlinks() },
    async () => {
      await fs.mkdir(path.dirname(dest()), { recursive: true });
      await fs.symlink(path.join(root, 'nowhere.md'), dest());
      assert.equal(await skillStatus('.claude', home), 'foreign');
    }
  );
});
