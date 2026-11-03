import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  fakeClaude,
  FakeProcess,
  fakeShell,
  tempHome,
  disposeHome,
  procStartFor,
  testPlatform,
  writeJson
} from '../helpers';

type Discover = typeof import('../../core/claude/discover');

let home: string;
let discover: Discover;
let fake: FakeProcess;
/** A pid that is alive but is not a `claude` process — a background session. */
let ownStart: number;
/** The fake CLI's start as `ps` states it — the clock `startedAt` is read on. */
let fakeStart: number;

const sessionsDir = () => path.join(home, '.claude', 'sessions');
const stateDir = () => path.join(home, '.squadron');

/**
 * A pid file as this platform's CLI writes it. A win32 table refuses a pid
 * file without a FILETIME `procStart`, so a fixture that names none gets the
 * table's start for the fake CLI or this process; one that names one keeps it.
 */
function pidFile(file: string, body: Record<string, unknown>): Promise<void> {
  const pid = Number(body.pid ?? path.basename(file, '.json'));
  const start = pid === fake.pid ? fakeStart : pid === process.pid ? ownStart : undefined;
  return writeJson(
    file,
    testPlatform() === 'win32' && body.procStart === undefined && start !== undefined
      ? { ...body, procStart: procStartFor(start) }
      : body
  );
}

/** Leaves only the session files a test wrote. */
async function reset(): Promise<void> {
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 10 };
  await fs.rm(path.join(home, '.claude'), options);
  await fs.rm(path.join(home, '.squadron'), options);
}

describe('discover', () => {
  before(async () => {
    home = await tempHome();
    discover = await import('../../core/claude/discover');
    const { scanProcesses } = await import('../../core/scan');
    fake = await fakeClaude();
    const table = await scanProcesses();
    ownStart = table.starts.get(process.pid) ?? 0;
    fakeStart = table.starts.get(fake.pid) ?? 0;
  });
  after(async () => {
    await fake.stop();
    await disposeHome(home);
  });

  it('is empty when the CLI has never run', async () => {
    await reset();
    assert.deepEqual(await discover.discover(), []);
  });

  it('reports a live session', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      name: 'project-fc',
      nameSource: 'derived',
      status: 'busy',
      startedAt: 1000,
      kind: 'interactive'
    });

    const [session, ...rest] = await discover.discover();
    assert.deepEqual(rest, []);
    assert.equal(session?.pid, fake.pid);
    assert.equal(session?.status, 'busy');
    assert.equal(session?.name, 'project-fc');
    // Interactive is not background, so the field the board gates verbs on is
    // absent rather than false.
    assert.equal(session?.background, undefined);
  });

  /** An answered turn at the path `transcriptPath` derives for a session, and
   *  the CLI's own title entry when one is asked for. */
  async function writeTranscript(
    cwd: string,
    sessionId: string,
    tokens: number,
    title?: string,
    model = 'claude-sonnet-5',
    custom?: string
  ): Promise<void> {
    const { transcriptPath } = await import('../../core/claude/transcript');
    const file = transcriptPath(cwd, sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // `cwd` is stated on every entry, and is where the session's transcript was
    // filed however far the session has since walked from it.
    const answer = {
      cwd,
      type: 'assistant',
      effort: 'medium',
      message: {
        model,
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: tokens, output_tokens: 3 }
      }
    };
    const entries: unknown[] = [answer];
    // The batch order the CLI writes when a session carries both: the given
    // name first, the titler's guess after it (protocol.md, conversations.ts).
    if (custom) {
      entries.push({ type: 'custom-title', customTitle: custom, sessionId });
    }
    if (title) {
      entries.push({ type: 'ai-title', aiTitle: title, sessionId });
    }
    await fs.writeFile(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  it('reads the transcript for what the session file does not carry', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      status: 'idle',
      startedAt: 1000,
      kind: 'interactive'
    });
    await writeTranscript('/tmp/project', 's1', 54321);

    const [session] = await discover.discover();
    assert.equal(session?.model, 'Sonnet 5');
    assert.equal(session?.effort, 'medium');
    // A count and no share: nothing in a transcript states the window size, and
    // no dump on this machine has said what this model answers in.
    assert.equal(session?.contextTokens, 54321);
    assert.equal(session?.contextPct, undefined);
    assert.equal(session?.contextSize, undefined);
  });

  it('holds a session that has walked off in the directory it lives in', async () => {
    await reset();
    // The CLI rewrites this field on every `cd`, and the transcript stays where
    // it was filed. Both readings followed the walk: the thread came back empty
    // and the card left its repository's group for one named after the
    // subdirectory the session had stepped into.
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 'walked',
      cwd: '/tmp/project/docs/mockups',
      status: 'idle',
      startedAt: 1000,
      kind: 'interactive'
    });
    await writeTranscript('/tmp/project', 'walked', 700);

    const { transcriptPath } = await import('../../core/claude/transcript');
    const [session] = await discover.discover();
    assert.equal(session?.cwd, '/tmp/project');
    assert.equal(session?.transcript, transcriptPath('/tmp/project', 'walked'));
    assert.equal(session?.contextTokens, 700);
  });

  it('states a share off the transcript, the window being the model’s', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      status: 'busy',
      startedAt: 1000,
      kind: 'interactive'
    });
    // The case the panel spawns into: a terminal too short for the CLI to draw
    // a status bar in, so no dump for this session will ever be written.
    await writeTranscript('/tmp/project', 's1', 156004, undefined, 'claude-opus-5');

    const [session] = await discover.discover();
    assert.equal(session?.contextTokens, 156004);
    // What that session's own bar said when it was made to draw one.
    assert.equal(session?.contextPct, 16);
    assert.equal(session?.contextSize, 1_000_000);
  });

  it('names a session from the transcript', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      name: 'project-fc',
      nameSource: 'derived',
      status: 'busy',
      startedAt: 1000,
      kind: 'interactive'
    });
    await writeTranscript('/tmp/project', 's1', 54321, 'Investigate unnamed sessions');

    const [session] = await discover.discover();
    // And no longer `derived`, which is what keeps `displayName` from cutting
    // the title down to its last word.
    assert.equal(session?.name, 'Investigate unnamed sessions');
    assert.equal(session?.nameSource, 'ai-title');
  });

  /** A session somebody has named: `/rename` rewrites the file and marks the
   *  name as given by deleting `nameSource` (protocol.md). */
  async function renamed(): Promise<void> {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      name: 'What I called it',
      status: 'busy',
      startedAt: 1000,
      kind: 'interactive'
    });
  }

  // The bug this caught: `/rename` landed — the session file said so within a
  // poll — and the card went back to the old title on the next one. The CLI
  // restamps `ai-title` with the pre-rename guess for the rest of the session's
  // life, and a session the panel spawned draws no status bar, so the transcript
  // was the only thing being read and it never stops disagreeing.
  it('keeps a renamed session’s name over the guess the transcript restamps', async () => {
    await renamed();
    await writeTranscript('/tmp/project', 's1', 54321, 'What it was called before');

    const [session] = await discover.discover();
    assert.equal(session?.name, 'What I called it');
    // The marker survives too, or `displayName` would fold the name away.
    assert.equal(session?.nameSource, undefined);
  });

  // The other rename door: `rename_session` on the control pipe answers success
  // and leaves the session file alone, so the transcript is the only witness
  // (protocol.md, "Rename: two doors"). A stated name beats a stated name by
  // being the fresher statement — the guess beside it still loses.
  it('takes a name stated in the transcript, which the session file never sees', async () => {
    await renamed();
    await writeTranscript(
      '/tmp/project',
      's1',
      54321,
      'What it was called before',
      'claude-sonnet-5',
      'Renamed on the control pipe'
    );

    const [session] = await discover.discover();
    assert.equal(session?.name, 'Renamed on the control pipe');
    assert.equal(session?.nameSource, undefined);
  });

  // 2.1.258 spells the marker the other way: `nameSource: "user"` for `--name`
  // and `/rename` alike, where 2.1.220–2.1.241 deleted the key (sessions.md).
  // Read as the absence, the guard above called every renamed session on that
  // version unstated and reopened the door it exists to shut.
  async function renamedOn2_1_258(): Promise<void> {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      name: 'What I called it',
      nameSource: 'user',
      status: 'busy',
      startedAt: 1000,
      kind: 'interactive'
    });
  }

  it('keeps it over the guess the transcript restamps, on that version too', async () => {
    await renamedOn2_1_258();
    await writeTranscript('/tmp/project', 's1', 54321, 'What it was called before');

    const [session] = await discover.discover();
    assert.equal(session?.name, 'What I called it');
    // The word the file gave, not one invented here: `views.ts` `named` folds
    // anything that is not `derived`, and `displayName` prints it verbatim.
    assert.equal(session?.nameSource, 'user');
  });

  it('reads all four fields off the transcript', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      status: 'idle',
      startedAt: 1000,
      kind: 'interactive'
    });
    await writeTranscript('/tmp/project', 's1', 54321, 'Titled by the model');

    const [session] = await discover.discover();
    assert.equal(session?.model, 'Sonnet 5');
    assert.equal(session?.effort, 'medium');
    assert.equal(session?.contextTokens, 54321);
    assert.equal(session?.name, 'Titled by the model');
    assert.equal(session?.nameSource, 'ai-title');
  });

  it('reports the checkout a session runs in, worktree and all', async () => {
    await reset();
    // A worktree of the shape this project uses: inside the repo it came from.
    const repo = path.join(home, 'repo');
    const tree = path.join(repo, '.claude', 'worktrees', 'wt');
    const admin = path.join(repo, '.git', 'worktrees', 'wt');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/feat/side\n');
    await fs.writeFile(path.join(admin, 'commondir'), '../..\n');
    await fs.mkdir(tree, { recursive: true });
    await fs.writeFile(path.join(tree, '.git'), `gitdir: ${admin}\n`);

    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: tree,
      status: 'busy',
      kind: 'interactive'
    });

    const [session] = await discover.discover();
    assert.equal(session?.branch, 'feat/side');
    assert.equal(session?.worktree, true);
    // The root, not the tree: this is what folds the card into the repo's group.
    assert.equal(session?.repoRoot, repo);
  });

  it('reads a checkout again on the next pass, so a later checkout lands', async () => {
    // The sweep memoises HEAD per git directory, and must not outlive itself:
    // one `discover` is one pass, and the branch a card shows follows a
    // `git checkout` typed in the session's own terminal.
    await reset();
    const repo = path.join(home, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: repo,
      status: 'busy',
      kind: 'interactive'
    });
    assert.equal((await discover.discover())[0]?.branch, 'main');

    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    assert.equal((await discover.discover())[0]?.branch, 'other');
  });

  it('follows a move no shell cd made, which only the transcript records', async () => {
    await reset();
    // The bug: a session moved by a worktree tool rather than by `cd` leaves the
    // pid file's `cwd` where it was, and a session spawned into the panel draws
    // no status bar, so no dump states `workspace.current_dir` either. The card
    // went on naming the branch of the checkout the session had left.
    const repo = path.join(home, 'moved');
    const tree = path.join(repo, '.claude', 'worktrees', 'side');
    const admin = path.join(repo, '.git', 'worktrees', 'side');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/feat/moved\n');
    await fs.writeFile(path.join(admin, 'commondir'), '../..\n');
    await fs.mkdir(tree, { recursive: true });
    await fs.writeFile(path.join(tree, '.git'), `gitdir: ${admin}\n`);

    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 'm1',
      cwd: repo,
      status: 'busy',
      kind: 'interactive'
    });
    // Filed where the session started, and its newest entry states the worktree.
    await writeTranscript(repo, 'm1', 100);
    const { transcriptPath } = await import('../../core/claude/transcript');
    await fs.appendFile(
      transcriptPath(repo, 'm1'),
      JSON.stringify({
        cwd: tree,
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5 }
        }
      }) + '\n'
    );

    const [session] = await discover.discover();
    assert.equal(session?.branch, 'feat/moved');
    assert.equal(session?.liveWorktree, true);
    assert.equal(session?.worktree, undefined);
    // Grouping stays home.
    assert.equal(session?.repoRoot, repo);
  });

  // The other direction, and the one that costs a heading: a session whose
  // conversation *began* in a worktree and has since stepped into the main
  // checkout. `branch` follows it out, but `worktree` may not — that flag is
  // read with `repoRoot` to fold the card into the repo the tree was cut from
  // (`ui/views.ts`, `buildGroups`), and taking the live reading's flag leaves
  // the pair describing two different directories. The card then heads a group
  // of its own, named after the worktree.
  it('keeps the grouping flag on the checkout the conversation began in', async () => {
    await reset();
    const repo = path.join(home, 'begun');
    const tree = path.join(repo, '.claude', 'worktrees', 'side');
    const admin = path.join(repo, '.git', 'worktrees', 'side');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/feat/begun\n');
    await fs.writeFile(path.join(admin, 'commondir'), '../..\n');
    await fs.mkdir(tree, { recursive: true });
    await fs.writeFile(path.join(tree, '.git'), `gitdir: ${admin}\n`);

    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 'b1',
      cwd: tree,
      status: 'busy',
      kind: 'interactive'
    });
    // Filed in the worktree it began in; its newest entry stands in the repo.
    await writeTranscript(tree, 'b1', 100);
    const { transcriptPath } = await import('../../core/claude/transcript');
    await fs.appendFile(
      transcriptPath(tree, 'b1'),
      JSON.stringify({
        cwd: repo,
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5 }
        }
      }) + '\n'
    );

    const [session] = await discover.discover();
    // What HEAD says where it stands now.
    assert.equal(session?.branch, 'main');
    // What folds the card into its repo: both read off the directory the
    // conversation began in, so both must survive the move.
    assert.equal(session?.worktree, true);
    assert.equal(session?.repoRoot, repo);
    // And the chip's own flag, which describes the branch beside it: the main
    // checkout is not a linked worktree.
    assert.equal(session?.liveWorktree, false);
  });

  it('keeps the home branch when the shell left every repo', async () => {
    await reset();
    const repo = path.join(home, 'anchored');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const away = path.join(home, 'nowhere');
    await fs.mkdir(away, { recursive: true });

    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: repo,
      status: 'busy',
      kind: 'interactive'
    });
    // Filed where the session started, and its newest entry has left every
    // repository — a live reading with no checkout to read a branch off.
    await writeTranscript(repo, 's1', 100);
    const { transcriptPath } = await import('../../core/claude/transcript');
    await fs.appendFile(
      transcriptPath(repo, 's1'),
      JSON.stringify({
        cwd: away,
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 5 }
        }
      }) + '\n'
    );

    const [session] = await discover.discover();
    assert.equal(session?.branch, 'main');
    assert.equal(session?.repoRoot, repo);
  });

  it('says nothing about git for a session outside any repository', async () => {
    await reset();
    const loose = path.join(home, 'scratch');
    await fs.mkdir(loose, { recursive: true });
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: loose,
      status: 'idle',
      kind: 'interactive'
    });

    const [session] = await discover.discover();
    assert.equal(session?.branch, undefined);
    assert.equal(session?.repoRoot, undefined);
  });

  it('reads the shell status as idle, holding a command', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      status: 'shell',
      startedAt: 1000
    });
    const [session] = await discover.discover();
    // `shell` is the CLI saying "idle, and still running something" in the one
    // field it has. Both halves survive the trip.
    assert.equal(session?.status, 'idle');
    assert.equal(session?.hasCommand, true);
  });

  it('sees a command in a state the CLI will not report it in', async () => {
    await reset();
    const { scanProcesses } = await import('../../core/scan');
    const shell = await fakeShell();
    try {
      // A busy session with a shell of its own: the status file says `busy` and
      // nothing else, because `shell` only ever overrides `idle`.
      await pidFile(path.join(sessionsDir(), `${process.pid}.json`), {
        entrypoint: 'sdk-cli',
        pid: process.pid,
        sessionId: 'working',
        cwd: '/tmp/project',
        status: 'busy',
        procStart: procStartFor(ownStart)
      });
      await scanProcesses(true);
      const [session] = await discover.discover();
      assert.equal(session?.status, 'busy');
      assert.equal(session?.hasCommand, true);
    } finally {
      await shell.stop();
    }
  });

  it('says nothing about a command when the session runs none', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      status: 'busy',
      startedAt: 1000
    });
    const [session] = await discover.discover();
    assert.equal(session?.hasCommand, false);
  });

  it('keeps a piped session and drops one somebody typed', async () => {
    // `sdk-cli` is what a session driven over a pipe writes about itself — the
    // only on-disk word for one of ours. Anything else is a session somebody
    // typed for, including a file written before the CLI stated an entrypoint
    // at all, and it is dropped before anything else about it is read.
    const write = (sessionId: string, entrypoint?: string) =>
      pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
        pid: fake.pid,
        sessionId,
        cwd: '/tmp/project',
        status: 'idle',
        startedAt: 1000,
        kind: 'interactive',
        ...(entrypoint === undefined ? {} : { entrypoint })
      });

    await reset();
    await write('piped', 'sdk-cli');
    const [piped] = await discover.discover();
    assert.equal(piped?.sessionId, 'piped');

    await reset();
    await write('typed', 'cli');
    assert.deepEqual(await discover.discover(), []);

    await reset();
    await write('silent');
    assert.deepEqual(await discover.discover(), []);
  });

  it('leaves brand for the adapter to stamp', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      pid: fake.pid,
      sessionId: 'piped',
      cwd: '/tmp/project',
      status: 'idle',
      startedAt: 1000,
      kind: 'interactive',
      entrypoint: 'sdk-cli'
    });
    const [walked] = await discover.discover();
    assert.equal(walked?.brand, undefined);
    const { adapter } = await import('../../core/adapter');
    const [named] = (await adapter('claude')?.discover()) ?? [];
    assert.equal(named?.brand, 'claude');
  });

  it('drops a session file whose process is gone', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), '999999.json'), {
      entrypoint: 'sdk-cli',
      pid: 999999,
      sessionId: 'dead',
      cwd: '/tmp/project',
      status: 'idle',
      startedAt: 1000
    });
    assert.deepEqual(await discover.discover(), []);
  });

  it('matches a background session on its UTC start time', async () => {
    await reset();
    // Not a `claude` process — the daemon runs these, so liveness is decided
    // by reconciling `procStart` with what `ps` reports in local time.
    await pidFile(path.join(sessionsDir(), `${process.pid}.json`), {
      pid: process.pid,
      sessionId: 'bg',
      cwd: '/tmp/project',
      status: 'busy',
      kind: 'bg',
      procStart: procStartFor(ownStart)
    });
    const [session] = await discover.discover();
    assert.equal(session?.sessionId, 'bg');
    // The process table dates it, as it dates every session here.
    assert.equal(session?.startedAt, ownStart);
    // The CLI's word for it is read here and nowhere above.
    assert.equal(session?.background, true);
  });

  it('reads every word the CLI has for a terminal-less session as one fact', async () => {
    // The validators list `interactive` · `bg` · `daemon` · `daemon-worker`
    // (`docs/reference/cli_state/claude/sessions.md`). `bg` is covered by the
    // liveness tests around this one; these are the two that had no case, and
    // this is the file that grows one when the CLI grows a word.
    for (const kind of ['daemon', 'daemon-worker']) {
      await reset();
      await pidFile(path.join(sessionsDir(), `${process.pid}.json`), {
        entrypoint: 'sdk-cli',
        pid: process.pid,
        sessionId: kind,
        cwd: '/tmp/project',
        status: 'busy',
        kind,
        procStart: procStartFor(ownStart)
      });
      const [session] = await discover.discover();
      assert.equal(session?.background, true, kind);
    }
  });

  it('does not match a background session whose start time disagrees', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${process.pid}.json`), {
      pid: process.pid,
      sessionId: 'recycled',
      cwd: '/tmp/project',
      status: 'busy',
      kind: 'bg',
      procStart: procStartFor(ownStart - 60_000)
    });
    assert.deepEqual(await discover.discover(), []);
  });

  it('drops a background session whose job has reached a terminal state', async () => {
    await reset();
    // Alive and start-time-matched, so liveness alone would keep it — but the
    // bg-spare host lingers past the work; the job's `done` state retires it.
    await pidFile(path.join(sessionsDir(), `${process.pid}.json`), {
      pid: process.pid,
      sessionId: 'finished',
      cwd: '/tmp/project',
      status: 'idle',
      kind: 'bg',
      jobId: 'job-done',
      procStart: procStartFor(ownStart)
    });
    await writeJson(path.join(home, '.claude', 'jobs', 'job-done', 'state.json'), {
      state: 'done'
    });
    assert.deepEqual(await discover.discover(), []);
  });

  it('keeps a background session whose job is still running', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${process.pid}.json`), {
      pid: process.pid,
      sessionId: 'running',
      cwd: '/tmp/project',
      status: 'busy',
      kind: 'bg',
      jobId: 'job-live',
      procStart: procStartFor(ownStart)
    });
    await writeJson(path.join(home, '.claude', 'jobs', 'job-live', 'state.json'), {
      state: 'running',
      needs: 'approve Bash: git log'
    });
    const [session] = await discover.discover();
    assert.equal(session?.sessionId, 'running');
    assert.equal(session?.needs, 'approve Bash: git log');
    assert.equal(session?.background, true);
  });

  it('falls back to unknown for a status it has never seen', async () => {
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      status: 'compacting',
      startedAt: 1000
    });
    const [session] = await discover.discover();
    assert.equal(session?.status, 'unknown');
  });

  describe('parentage from the lineage record', () => {
    /**
     * A child session on the fake claude.
     *
     * It starts when `ps` says it did, so what a test varies is where the edge
     * sits against `fakeStart`. The stamp in the file is the CLI's own, a beat
     * late and read by nobody — `core/claude/discover.ts`.
     */
    async function child(): Promise<void> {
      await reset();
      await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
        entrypoint: 'sdk-cli',
        pid: fake.pid,
        sessionId: 'child-1',
        cwd: '/tmp/project',
        status: 'idle',
        startedAt: fakeStart + 300
      });
    }

    /** An edge keyed on the session's own pid, with a fan-out if given. */
    async function edge(
      spawnedAt: number,
      parentSessionId?: string,
      originSessionId?: string
    ): Promise<void> {
      await writeJson(path.join(stateDir(), 'lineage', `${fake.pid}.json`), {
        schema: 1,
        parentSessionId,
        originSessionId,
        spawnedAt,
        cwd: '/tmp/project',
        requestId: 'req-1'
      });
    }

    /**
     * An edge keyed on the session's **own** pid, which is how a spawn the panel
     * drives records one: the child is the extension host's, so there is no
     * shell in between to name it by.
     */
    async function ownEdge(spawnedAt: number, parentSessionId?: string): Promise<void> {
      await writeJson(path.join(stateDir(), 'lineage', `${fake.pid}.json`), {
        schema: 1,
        parentSessionId,
        spawnedAt,
        cwd: '/tmp/project',
        requestId: 'req-2'
      });
    }

    it('says nothing when there is no edge', async () => {
      await child();

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, undefined);
    });

    it('ignores an edge that names no parent', async () => {
      // Written for the spawn cap's sake, which counts entries rather than edges.
      await child();
      await edge(fakeStart + 500);

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, undefined);
    });

    it('does not resurrect a card for a child that has gone', async () => {
      await reset();
      await edge(fakeStart + 500, 'parent-1');
      assert.deepEqual(await discover.discover(), []);
    });

    it('names the parent of a session the panel spawned as its own child', async () => {
      // No claim, and so no shell ancestor to look an edge up by — which is
      // exactly the shape of a print-mode child of an extension host. Before
      // this, a parent and its children could sit on one board unjoined.
      await child();
      await ownEdge(fakeStart + 500, 'parent-1');

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, 'parent-1');
    });

    it('bounds an edge on the session’s own pid by start time too', async () => {
      // A pid is recycled sooner than a shell is reused, so the guard that keeps
      // a re-run terminal off a dead child's parent has to hold on this key.
      await child();
      await ownEdge(fakeStart + 4000, 'parent-1');

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, undefined);
    });

    it('names the fan-out the spawn belonged to, beside the parent', async () => {
      await child();
      await edge(fakeStart + 500, 'parent-1', 'gen1');

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, 'parent-1');
      assert.equal(session?.originSessionId, 'gen1');
    });

    it('stamps the fan-out of an edge that names no parent', async () => {
      // One condition over both fields would drop this: an agent may write an
      // origin without a parent, and the fan-out is still known.
      await child();
      await edge(fakeStart + 500, undefined, 'gen1');

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, undefined);
      assert.equal(session?.originSessionId, 'gen1');
    });

    it('lets a stale edge stamp neither field', async () => {
      await child();
      await edge(fakeStart - 3600_000, 'parent-1', 'gen1');

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, undefined);
      assert.equal(session?.originSessionId, undefined);
    });

    it('forgets a stale edge on the session’s own pid too', async () => {
      // Where it bites hardest: an edge keyed by the child's own pid outlives it
      // by up to the seven days `pruneStatus` allows, and pids wrap.
      await child();
      await ownEdge(fakeStart - 3600_000, 'parent-1');

      const [session] = await discover.discover();
      assert.equal(session?.parentSessionId, undefined);
    });
  });

  it('dates a session by the process table, not by the CLI’s own stamp', async () => {
    // The CLI writes this file once it has finished booting, which is not when
    // the process started: measured 6781 ms apart on a machine running ten
    // sessions, against 311–1767 ms for the other nine (2026-09-16). Every
    // reader joins `startedAt` against a stamp taken at the spawn — the owning
    // window's published record most of all — so the CLI's number put that
    // session outside `sameSessionStart` for the rest of its life, and no shim
    // could name the window holding its pipe.
    await reset();
    await pidFile(path.join(sessionsDir(), `${fake.pid}.json`), {
      entrypoint: 'sdk-cli',
      pid: fake.pid,
      sessionId: 's1',
      cwd: '/tmp/project',
      status: 'idle',
      startedAt: fakeStart + 6781,
      procStart: procStartFor(fakeStart)
    });

    const [session] = await discover.discover();
    assert.equal(session?.startedAt, fakeStart);
  });

  it('orders by start time, then pid, and never by status', async () => {
    // What this pins is that the CLI's stamps decide nothing and that status
    // never orders the list. Both starts are real `lstart` readings, so the two
    // processes may share a second, and pids wrap — a fake at pid 242 under a
    // runner at 99931 has been seen. The expected order is read off the real
    // starts, and the stamps are written to run the other way.
    await reset();
    const expected = [
      [fake.pid, fakeStart],
      [process.pid, ownStart]
    ]
      .sort(([pidA, startA], [pidB, startB]) => startA! - startB! || pidA! - pidB!)
      .map(([pid]) => pid!);
    for (const [index, pid] of expected.entries()) {
      await pidFile(path.join(sessionsDir(), `${pid}.json`), {
        entrypoint: 'sdk-cli',
        pid,
        sessionId: `s${pid}`,
        cwd: '/tmp/project',
        status: index === 0 ? 'idle' : 'waiting',
        startedAt: index === 0 ? 5000 : 1000,
        procStart: procStartFor(pid === fake.pid ? fakeStart : ownStart)
      });
    }
    const order = (await discover.discover()).map((s) => s.pid);
    assert.deepEqual(order, expected);
  });
});
