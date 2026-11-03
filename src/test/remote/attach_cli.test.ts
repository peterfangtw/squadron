import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { tempHome } from '../helpers';
import type { Holder } from '../../core/remote/holder';
import type { Session } from '../../core/model';

type Cli = typeof import('../../cli/attach');
type Rules = typeof import('../../core/remote/attach');

let cli: Cli;
let rules: Rules;
let state: string;
let cwd: string;
let tmp: string;

before(async () => {
  const home = await tempHome();
  cli = await import('../../cli/attach');
  rules = await import('../../core/remote/attach');
  state = path.join(home, '.squadron');
  await fs.mkdir(path.join(state, 'remote'), { recursive: true });
  await fs.writeFile(path.join(state, 'remote', 'holder.json'), '{}');
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-attach-cli-')));
  cwd = path.join(base, 'app');
  tmp = path.join(base, 'tmp');
  await fs.mkdir(path.join(cwd, '.secrets'), { recursive: true });
  await fs.mkdir(path.join(cwd, 'shots'), { recursive: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(cwd, 'plot.png'), 'png bytes');
  await fs.writeFile(path.join(cwd, 'empty.txt'), '');
  await fs.writeFile(path.join(cwd, '.secrets', 'key'), 'key');
  await fs.writeFile(path.join(cwd, 'huge.bin'), '');
  await fs.truncate(path.join(cwd, 'huge.bin'), rules.ATTACH_MAX_BYTES + 1);
  await fs.writeFile(path.join(base, 'elsewhere.txt'), 'elsewhere');
});

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd,
  name: 'plotter',
  status: 'busy',
  hasCommand: false,
  startedAt: 1000,
  updatedAt: 0,
  transcript: '',
  source: 'owned',
  windowId: 'w-session',
  ...over
});

const holder: Holder = {
  windowId: 'w-holder',
  label: 'holder',
  pid: 1,
  startedAt: 1,
  since: 0
};

const CLAUDE = { CLAUDE_CODE_SESSION_ID: 'sid-100' };

/** Everything `main` reads, done for real, then the plan. */
async function plan(
  opts: import('../../cli/attach').Options,
  over: {
    sessions?: Session[];
    env?: NodeJS.ProcessEnv;
    holder?: Holder | undefined;
    context?: import('../../core/session_target').TargetContext;
  } = {}
) {
  const sessions = over.sessions ?? [session()];
  const ids = cli.callerIds(over.env ?? CLAUDE);
  const caller = cli.callerOf(sessions, ids);
  const file =
    opts['file-path'] === undefined ? undefined : await rules.inspectFile(opts['file-path'], cwd);
  const area = {
    roots: 'ok' in caller ? [] : await rules.attachRoots(caller.cwd, { tmp: [tmp] }),
    deny: await rules.realDirs([state])
  };
  return cli.attachPlan(
    opts,
    sessions,
    ids,
    'holder' in over ? over.holder : holder,
    file,
    area,
    over.context
  );
}

function refusal(result: Awaited<ReturnType<typeof plan>>): { code: number; reason: string } {
  assert.ok(!result.ok, 'expected a refusal');
  return result;
}

describe('parseArgs', () => {
  it('reads the file and the caption', () => {
    assert.deepEqual(cli.parseArgs(['--file-path', 'a.png', '--caption', 'hi']), {
      'file-path': 'a.png',
      caption: 'hi'
    });
  });

  it('is malformed on an unknown flag — --pid and --caller-session-id included', () => {
    assert.equal(cli.parseArgs(['--pid', '4']), undefined);
    assert.equal(cli.parseArgs(['--caller-session-id', 'sid']), undefined);
    assert.equal(cli.parseArgs(['--fiel', 'a.png']), undefined);
  });
});

describe('attachPlan: the arguments', () => {
  it('is usage with no --file-path', async () => {
    assert.equal(refusal(await plan({})).code, 1);
  });

  it('is usage for a caption over the limit, or with control characters', async () => {
    const long = 'x'.repeat(rules.CAPTION_MAX + 1);
    assert.equal(refusal(await plan({ 'file-path': 'plot.png', caption: long })).code, 1);
    assert.equal(refusal(await plan({ 'file-path': 'plot.png', caption: 'a\u0007b' })).code, 1);
  });
});

describe('attachPlan: who is asking', () => {
  const rows: [string, NodeJS.ProcessEnv][] = [
    ['Claude', { CLAUDE_CODE_SESSION_ID: 'sid-7' }],
    ['Grok', { GROK_SESSION_ID: 'sid-7', GROK_AGENT: '1' }],
    ['Codex', { CODEX_SESSION_ID: 'sid-7' }]
  ];
  for (const [brand, env] of rows) {
    it(`finds a ${brand} caller by the id its CLI planted`, async () => {
      const sessions = [session(), session({ pid: 7, sessionId: 'sid-7' })];
      const found = await plan({ 'file-path': 'plot.png' }, { sessions, env });
      assert.ok(found.ok, found.ok ? '' : found.reason);
      assert.equal(found.body.pid, 7);
      assert.equal(found.body.from, 'sid-7');
    });
  }

  it('settles two sessions on one id by the pid Claude plants', async () => {
    const sessions = [session({ pid: 10 }), session({ pid: 11 })];
    const found = await plan(
      { 'file-path': 'plot.png' },
      { sessions, env: { ...CLAUDE, CLAUDE_PID: '11' } }
    );
    assert.ok(found.ok);
    assert.equal(found.body.pid, 11);
  });

  it('refuses the tie when no planted pid names one of them', async () => {
    const sessions = [session({ pid: 10 }), session({ pid: 11 })];
    const grok = { GROK_SESSION_ID: 'sid-100', GROK_AGENT: '1' };
    const codex = { CODEX_SESSION_ID: 'sid-100' };
    const stray = { ...CLAUDE, CLAUDE_PID: '12' };
    for (const env of [grok, codex, stray]) {
      const refused = refusal(await plan({ 'file-path': 'plot.png' }, { sessions, env }));
      assert.equal(refused.code, 2);
      assert.match(refused.reason, /2 live sessions share sid-100/);
    }
  });

  it('refuses when nothing in the environment names a session', async () => {
    const refused = refusal(await plan({ 'file-path': 'plot.png' }, { env: {} }));
    assert.equal(refused.code, 2);
    assert.match(refused.reason, /cannot tell which session/);
  });

  it('refuses a caller on no row of the board', async () => {
    const refused = refusal(
      await plan({ 'file-path': 'plot.png' }, { env: { CLAUDE_CODE_SESSION_ID: 'sid-gone' } })
    );
    assert.equal(refused.code, 2);
    assert.match(refused.reason, /sid-gone is not a session any window drives/);
  });
});

describe('attachPlan: whether Remote can see it', () => {
  it('uses the fact owner for the session while addressing the holder, with missing claims advisory', async () => {
    const caller = session({
      source: undefined,
      windowId: undefined,
      control: { canControl: true, owner: { kind: 'window', windowId: 'fact-owner' } }
    });
    const result = await plan(
      { 'file-path': 'plot.png' },
      { sessions: [caller], context: { claims: [] } }
    );
    assert.ok(result.ok);
    assert.equal(result.body.windowId, 'w-holder');
    assert.equal(result.body.sessionWindowId, 'fact-owner');
    assert.equal(result.body.startedAt, caller.startedAt);
    const published = new Map([[caller.pid, { session: caller, exit: { code: 0, signal: null } }]]);
    assert.match(
      refusal(
        await plan({ 'file-path': 'plot.png' }, { sessions: [caller], context: { published } })
      ).reason,
      /exited/
    );
  });

  it('refuses a background caller', async () => {
    const sessions = [session({ background: true })];
    assert.match(
      refusal(await plan({ 'file-path': 'plot.png' }, { sessions })).reason,
      /background/
    );
  });

  it('refuses a caller that is not owned', async () => {
    const { source, ...unowned } = session();
    assert.equal(source, 'owned');
    const refused = refusal(await plan({ 'file-path': 'plot.png' }, { sessions: [unowned] }));
    assert.equal(refused.code, 2);
    assert.match(refused.reason, /no window publishes a pipe/);
  });

  it('refuses a caller no window claims', async () => {
    const { windowId, ...orphan } = session();
    assert.equal(windowId, 'w-session');
    assert.match(
      refusal(await plan({ 'file-path': 'plot.png' }, { sessions: [orphan] })).reason,
      /no window claims/
    );
  });

  it('refuses when no window holds Remote', async () => {
    const refused = refusal(await plan({ 'file-path': 'plot.png' }, { holder: undefined }));
    assert.equal(refused.code, 2);
    assert.equal(refused.reason, 'Remote is off, so there is no conversation to send to.');
  });
});

describe('attachPlan: the file', () => {
  const cases: [string, () => string, RegExp][] = [
    ['a missing file', () => 'nope.png', /no such file/],
    ['a directory', () => 'shots', /directory/],
    ['an empty file', () => 'empty.txt', /empty/],
    ['a file over the cap', () => 'huge.bin', /10 MiB/],
    ['a hidden path', () => path.join('.secrets', 'key'), /hidden/],
    ['a file outside the roots', () => path.join('..', 'elsewhere.txt'), /outside/],
    ['the state directory', () => path.join(state, 'remote', 'holder.json'), /never sent/]
  ];
  for (const [what, raw, reason] of cases) {
    it(`refuses ${what} with exit 2`, async () => {
      const refused = refusal(await plan({ 'file-path': raw() }));
      assert.equal(refused.code, 2);
      assert.match(refused.reason, reason);
    });
  }

  it('admits a file in the temp directory', async () => {
    await fs.writeFile(path.join(tmp, 'screen.png'), 'png');
    assert.equal((await plan({ 'file-path': path.join(tmp, 'screen.png') })).ok, true);
  });
});

describe('attachPlan: the request', () => {
  it('goes to the holder, naming the session and its own window', async () => {
    const found = await plan({ 'file-path': 'plot.png', caption: '  the plot  ' });
    assert.ok(found.ok, found.ok ? '' : found.reason);
    assert.deepEqual(found.body, {
      kind: 'attach',
      windowId: 'w-holder',
      pid: 100,
      startedAt: 1000,
      sessionWindowId: 'w-session',
      path: path.join(cwd, 'plot.png'),
      caption: 'the plot',
      from: 'sid-100'
    });
    assert.equal(found.name, 'plot.png');
    assert.equal(found.size, 'png bytes'.length);
  });

  it('carries no caption when none was given', async () => {
    const found = await plan({ 'file-path': 'plot.png', caption: '   ' });
    assert.ok(found.ok);
    assert.equal('caption' in found.body, false);
  });
});

describe('attached', () => {
  it("names the file, its size and this session's conversation", () => {
    assert.equal(
      cli.attached('plot.png', 2_400_000),
      "sent plot.png (2.3 MB) to this session's conversation\n"
    );
    assert.equal(
      cli.attached('a.txt', 12),
      "sent a.txt (12 bytes) to this session's conversation\n"
    );
  });
});

describe('failure', () => {
  const file = '/requests/0b5e.request.json';

  it('exits 4 when the holder never answered, and says the file may have gone', () => {
    const out = cli.failure({ ok: false, kind: 'silent', reason: 'no answer', file });
    assert.equal(out.code, 4);
    assert.match(out.reason, /0b5e/);
    assert.match(out.reason, /may have been posted/);
  });

  it('exits 4, not 2, when the holder answered that the upload may have landed', () => {
    const reply = {
      ok: false,
      reason: 'files.completeUploadExternal: unreadable_reply',
      unsure: true
    } as const;
    const out = cli.failure({ ok: false, kind: 'refused', reason: reply.reason, reply, file });
    assert.equal(out.code, 4);
    assert.match(out.reason, /unreadable_reply/);
    assert.match(out.reason, /may have been posted/);
  });

  it('exits 2 with the reason for a refusal, and 5 for a request never written', () => {
    const reply = { ok: false, reason: 'the messenger said no' };
    assert.deepEqual(cli.failure({ ok: false, kind: 'refused', reason: 'x', reply, file }), {
      code: 2,
      reason: 'the messenger said no'
    });
    assert.equal(cli.failure({ ok: false, kind: 'unwritable', reason: 'disk' }).code, 5);
  });
});
