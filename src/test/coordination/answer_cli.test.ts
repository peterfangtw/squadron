import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cli from '../../cli/answer';
import { describe, it } from 'node:test';
import { answerPlan, parseArgs, type AnswerPlan } from '../../cli/answer';
import { unwrapMessage } from '../../core/coordination/send';
import type { CountedAction } from '../../core/coordination/actions';
import { SEND_BURST, TARGET_STALE_MS } from '../../core/coordination/guards';
import type { PendingRequest } from '../../core/live';
import { Session } from '../../core/model';
import type { PublishedLive } from '../../core/published';
import type { TargetContext } from '../../core/session_target';

const NOW = 1_700_000_000_000;

const session = (over: Partial<Session> = {}): Session => ({
  pid: 100,
  sessionId: 'sid-100',
  cwd: '/work/app',
  name: 'card',
  status: 'waiting',
  hasCommand: false,
  startedAt: 0,
  updatedAt: NOW - 60_000,
  transcript: '/tmp/t.jsonl',
  source: 'owned',
  windowId: 'w1',
  ...over
});

const question: PendingRequest = {
  requestId: 'req_7',
  toolName: 'AskUserQuestion',
  ask: true,
  questions: [
    {
      question: 'Which database?',
      multiSelect: false,
      options: [{ label: 'Postgres' }, { label: 'SQLite' }]
    }
  ]
};

const published = (
  pending: PendingRequest[] = [question],
  over: Partial<PublishedLive> = {}
): Map<number, PublishedLive> =>
  new Map([[100, { schema: 1, session: session(), pending, queued: [], ...over }]]);

const board = (over: Partial<Session> = {}) => [
  session(over),
  session({ pid: 1, sessionId: 'me', name: 'caller', status: 'idle' })
];

function plan(
  opts: Parameters<typeof answerPlan>[0] = {},
  sessions = board(),
  records = published(),
  callerId: string | undefined = 'me',
  actions: readonly CountedAction[] = [],
  context: TargetContext = {}
): AnswerPlan {
  return answerPlan(
    { pid: '100', 'request-id': 'req_7', answers: '[{"answer":"Postgres"}]', ...opts },
    sessions,
    records,
    callerId,
    actions,
    NOW,
    context
  );
}

function refusal(result: AnswerPlan): { code: 1 | 2; reason: string } {
  assert.ok(!result.ok, 'expected a refusal');
  return result;
}

describe('parseArgs', () => {
  it('takes the three required flags and the two optional ones', () => {
    assert.deepEqual(
      parseArgs([
        '--pid',
        '7',
        '--request-id',
        'r',
        '--answers',
        '[]',
        '--caller-session-id',
        'me',
        '--force'
      ]),
      { pid: '7', 'request-id': 'r', answers: '[]', 'caller-session-id': 'me', force: '' }
    );
  });

  it('refuses a flag it does not take', () => {
    assert.equal(parseArgs(['--pid', '7', '--text', 'hi']), undefined);
  });
});

describe('answerPlan', () => {
  it('plans the answer as prose, attributed, to the window holding the asker’s pipe', () => {
    const result = plan();
    assert.ok(result.ok);
    assert.deepEqual(result.address, { pid: 100, startedAt: 0, windowId: 'w1' });
    assert.equal(result.askId, 'req_7');
    assert.equal(result.from, 'me');
    const sent = unwrapMessage(result.text);
    assert.equal(sent?.from, 'me');
    assert.match(sent?.text ?? '', /"Which database\?"="Postgres"$/);
  });

  it('delivers words no option offers', () => {
    const result = plan({ answers: '[{"answer":"MySQL, actually"}]' });
    assert.ok(result.ok);
    assert.match(result.text, /"Which database\?"="MySQL, actually"/);
  });

  it('refuses malformed arguments as usage, exit 1', () => {
    assert.equal(refusal(plan({ pid: 'x' })).code, 1);
    assert.match(refusal(plan({ 'request-id': undefined })).reason, /--request-id/);
    assert.match(refusal(plan({ answers: undefined })).reason, /--answers is required/);
    const bad = refusal(plan({ answers: '[{pick:' }));
    assert.equal(bad.code, 1);
    assert.match(bad.reason, /not JSON/);
  });

  it('refuses a caller it cannot name', () => {
    assert.match(refusal(plan({}, board(), published(), '')).reason, /--caller/);
  });

  it('refuses a pid nobody can be asked to answer on', () => {
    assert.match(refusal(plan({ pid: '555' })).reason, /no session on the board/);
    const background = refusal(plan({ force: '' }, board({ background: true }))).reason;
    assert.match(background, /background/);
    assert.doesNotMatch(background, /has a pipe/);
    assert.match(refusal(plan({}, board({ windowId: undefined }))).reason, /no window claims/);
    assert.match(
      refusal(plan({ force: '' }, board({ source: undefined, windowId: 'w-bare' }))).reason,
      /no window publishes a pipe/
    );
  });

  it('refuses a request that is not open on the published record', () => {
    assert.match(refusal(plan({ 'request-id': 'req_6' })).reason, /no longer open/);
    // An earlier run of the same pid, and a session that has ended.
    const stale = published([question], { session: session({ startedAt: 90_000 }) });
    assert.match(refusal(plan({}, board(), stale)).reason, /no longer open/);
    const ended = published([question], { exit: { code: 0, signal: null } });
    assert.match(refusal(plan({}, board(), ended)).reason, /no longer open/);
    // Exit is said before a cost guard, and it keeps this sentence.
    const cold = board({ updatedAt: NOW - TARGET_STALE_MS - 60_000 });
    const why = refusal(plan({ force: '' }, cold, ended)).reason;
    assert.equal(why, 'That question is no longer open.');
    assert.doesNotMatch(why, /idle/);
  });

  it('refuses a permission, with --force or without', () => {
    const permission: PendingRequest = { requestId: 'req_7', toolName: 'Bash', ask: false };
    const result = plan({ answers: '[]', force: '' }, board(), published([permission]));
    assert.equal(refusal(result).code, 2);
    assert.match(refusal(result).reason, /granted only by a person/);
  });

  it('refuses answers that do not cover the request, one entry per question', () => {
    const result = plan({ answers: '[{"answer":"Postgres"},{"answer":"SQLite"}]' });
    assert.equal(refusal(result).code, 2);
    assert.match(refusal(result).reason, /1 question;/);
  });

  it('refuses an asker gone cold, and --force lifts it', () => {
    const cold = board({ updatedAt: NOW - TARGET_STALE_MS - 60_000 });
    assert.match(refusal(plan({}, cold)).reason, /idle for 56 minutes.*--force/);
    assert.equal(plan({ force: '' }, cold).ok, true);
  });

  it('refuses an asker past its published cache deadline, though active a minute ago', () => {
    const stamped = board({
      cache: { ttlMs: 60 * 60_000, source: 'measured', at: NOW - 58 * 60_000 }
    });
    assert.match(refusal(plan({}, stamped)).reason, /prompt-cache deadline/);
    assert.equal(plan({ force: '' }, stamped).ok, true);
  });

  it('accepts an asker with full context without force', () => {
    const full = board({ contextPct: 100 });
    assert.equal(plan({}, full).ok, true);
  });

  it('shares send’s window burst, and --force does not lift it', () => {
    const busy = Array.from({ length: SEND_BURST }, (_, i): CountedAction => ({
      schema: 1,
      kind: 'send',
      windowId: 'w1',
      from: 'me',
      toPid: 100,
      at: NOW - i * 1000,
      requestId: `r${i}`
    }));
    assert.match(
      refusal(plan({ force: '' }, board(), published(), 'me', busy)).reason,
      /this IDE window/
    );
    const other = busy.map((row) => ({ ...row, windowId: 'w2' }));
    assert.equal(plan({}, board(), published(), 'me', other).ok, true);
  });

  it('addresses the owner fact, and a missing claim does not refuse', () => {
    const owned = {
      canControl: true as const,
      owner: { kind: 'window' as const, windowId: 'w-owned' }
    };
    const row = session({ startedAt: 2500, windowId: undefined, control: owned });
    const records = published([question], { session: row });
    const result = plan({}, [row, session({ pid: 1, sessionId: 'me' })], records, 'me', [], {
      claims: [{ id: 'elsewhere' }]
    });
    assert.ok(result.ok);
    assert.deepEqual(result.address, { pid: 100, startedAt: 2500, windowId: 'w-owned' });
  });

  it('fails closed on invalid control before a permission can be answered', () => {
    const permission: PendingRequest = { requestId: 'req_7', toolName: 'Bash', ask: false };
    const row = session({
      control: { canControl: false, reason: 'invalid' },
      source: 'owned',
      windowId: 'w1',
      name: 'kept'
    });
    const why = refusal(
      plan({ force: '' }, [row, session({ pid: 1, sessionId: 'me' })], published([permission]))
    ).reason;
    assert.match(why, /invalid control facts/);
    assert.doesNotMatch(why, /granted only by a person/);
  });
});

describe('answer input at the CLI boundary', () => {
  const read = cli.readAnswerInput;

  it('reads explicit UTF-8 with an optional initial BOM and preserves inline bytes', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'answer-input-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, '答案 file.json');
    const json = JSON.stringify([{ answer: '中文 😀 "quoted"\nnext line' }], null, 2);
    assert.deepEqual(parseArgs(['--answers-file', file]), { 'answers-file': file });
    for (const bom of ['', '\ufeff']) {
      await fs.writeFile(file, bom + json, 'utf8');
      assert.deepEqual(await read({ 'answers-file': file }), { ok: true, answers: json });
    }
    assert.deepEqual(await read({ answers: json }), { ok: true, answers: json });
    // Inline BOM behavior remains JSON.parse's existing rejection.
    assert.deepEqual(await read({ answers: '\ufeff' + json }), {
      ok: true,
      answers: '\ufeff' + json
    });
  });

  it('rejects missing, conflicting, unreadable, malformed and non-UTF-8 inputs', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'answer-invalid-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'answers.json');
    for (const opts of [
      {},
      { answers: '[]', 'answers-file': file },
      { 'answers-file': '' },
      { 'answers-file': file },
      { 'answers-file': dir }
    ]) {
      assert.equal((await read(opts)).ok, false, JSON.stringify(opts));
    }
    for (const body of [
      Buffer.from(''),
      Buffer.from('{broken'),
      Buffer.from('\ufeff\ufeff[]'),
      Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]),
      Buffer.from('[]', 'utf16le')
    ]) {
      await fs.writeFile(file, body);
      assert.equal((await read({ 'answers-file': file })).ok, false, body.toString('hex'));
    }
  });

  it('accepts the 96 KiB byte boundary and refuses a larger sparse file', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'answer-limit-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'answers.json');
    const json = '[]' + ' '.repeat(96 * 1024 - 2);
    await fs.writeFile(file, json);
    assert.deepEqual(await read({ 'answers-file': file }), { ok: true, answers: json });
    await fs.truncate(file, 1024 * 1024 * 1024);
    const result = await read({ 'answers-file': file });
    assert.ok(!result.ok);
    assert.match(result.reason, /98304|96 KiB/);
  });

  it('enforces the byte cap even when a regular file grows after stat', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'answer-growth-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'answers.json');
    await fs.writeFile(file, '[]');
    const open = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      t.mock.method(handle, 'stat', async () => {
        const observed = await stat();
        await fs.appendFile(file, ' '.repeat(96 * 1024));
        return observed;
      });
      return handle;
    });
    const result = await read({ 'answers-file': file });
    assert.ok(!result.ok);
    assert.match(result.reason, /98304|96 KiB/);
  });
});
