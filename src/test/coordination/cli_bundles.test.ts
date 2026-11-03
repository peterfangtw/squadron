import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as disk from 'node:fs/promises';
import * as helpers from '../helpers';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { homeEnv, repoRoot } from '../helpers';

const run = promisify(execFile);

/** Every home a case here made, removed once the file's bundles have exited. */
const made: string[] = [];
async function freshHome(): Promise<string> {
  const home = await helpers.tempHome();
  made.push(home);
  return home;
}
after(async () => {
  for (const home of made.splice(0)) await helpers.disposeHome(home);
});

/**
 * Every `dist/squadron-*.js` answers as itself, and nothing else does.
 *
 * esbuild puts every imported module in one bundle, where each verb's
 * `require.main === module` is true at once — so a verb importing from another
 * verb's file runs that verb's `main` too. `step.ts` importing `openSession`
 * from `spawn.ts` made every `squadron-step` call die on spawn's usage line,
 * with the whole unit suite green, because the tests import `out/` and never
 * the bundle (smoke, 2026-09-30). A bogus flag is the cheapest call every verb
 * refuses as usage, so the prefix on that refusal says whose `main` ran.
 */
describe('the shipped CLI bundles', () => {
  const dist = path.join(repoRoot(), 'dist');
  const bundles = fs.existsSync(dist)
    ? fs.readdirSync(dist).filter((name) => /^squadron-[a-z-]+\.js$/.test(name))
    : [];

  it('are there to check', () => {
    assert.ok(bundles.includes('squadron-step.js'), 'run npm run compile: no bundles in dist/');
  });

  for (const bundle of bundles) {
    const verb = bundle.replace(/\.js$/, '');
    it(`${verb} refuses a bogus flag in its own name, and no other verb speaks`, async () => {
      const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bundle-'));
      const failed = await run(process.execPath, [path.join(dist, bundle), '--no-such-flag'], {
        env: { PATH: process.env.PATH ?? '', ...homeEnv(home) }
      }).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error
      );
      assert.equal(failed?.code, 1);
      const speakers = new Set((failed?.stderr ?? '').match(/squadron-[a-z-]+(?=: )/g) ?? []);
      assert.deepEqual([...speakers], [verb]);
    });
  }

  for (const bundle of [...bundles, 'workflow-validation.js']) {
    const command = bundle.replace(/\.js$/, '');
    it(`${command} explains its contract without an IDE or state changes`, async () => {
      const home = await freshHome();
      const before = await disk.readdir(home, { recursive: true });
      const calls =
        command === 'squadron-step'
          ? [['--help'], ...['start', 'next', 'done'].map((verb) => [verb, '--help'])]
          : [['--help']];
      for (const argv of calls) {
        const result = await run(process.execPath, [path.join(dist, bundle), ...argv], {
          cwd: home,
          env: { PATH: process.env.PATH ?? '', ...homeEnv(home) },
          timeout: 6000
        });
        assert.equal(result.stderr, '');
        assert.match(result.stdout, new RegExp(`usage: ${command}(?: |\\n)`));
        for (const section of [
          'Options:',
          'Result:',
          'Exit codes:',
          'Recovery:',
          'Related commands:'
        ]) {
          assert.ok(result.stdout.includes(section), `${command}: missing ${section}`);
        }
        if (argv[0] !== '--help') {
          assert.match(result.stdout, new RegExp(`usage: squadron-step ${argv[0]}(?: |\\n)`));
          if (argv[0] === 'start' || argv[0] === 'done') {
            assert.doesNotMatch(result.stdout, /^ {2}[34] {2}/m);
          }
        }
      }
      assert.deepEqual(await disk.readdir(home, { recursive: true }), before);
    });
  }

  for (const bundle of [...bundles, 'workflow-validation.js']) {
    const command = bundle.replace(/\.js$/, '');
    it(`${command} reads its whole command line from --argv-file, and only that way`, async () => {
      const home = await freshHome();
      const file = (name: string, text: string) => {
        const at = path.join(home, name);
        fs.writeFileSync(at, text);
        return at;
      };
      const help = file("help 中文 & it's.json", '﻿["--help"]');
      const shown = await run(process.execPath, [path.join(dist, bundle), '--argv-file', help], {
        cwd: home,
        env: { PATH: process.env.PATH ?? '', ...homeEnv(home) },
        timeout: 6000
      });
      assert.match(shown.stdout, new RegExp(`usage: ${command}(?: |\\n)`));
      const bogus = file('bogus.json', '["--no-such-flag", "two\\nlines \\"q\\""]');
      const refused = [
        ['--argv-file', bogus],
        ['--argv-file', file('nested.json', JSON.stringify(['--argv-file', bogus]))],
        ['--argv-file', bogus, '--help'],
        ['--argv-file', file('object.json', '{"argv":[]}')],
        ['--argv-file', path.join(home, 'missing.json')]
      ];
      const before = await disk.readdir(home, { recursive: true });
      for (const argv of refused) {
        const failed = await run(process.execPath, [path.join(dist, bundle), ...argv], {
          cwd: home,
          env: { PATH: process.env.PATH ?? '', ...homeEnv(home) },
          timeout: 6000
        }).then(
          () => undefined,
          (error: { code?: number; stderr?: string }) => error
        );
        assert.equal(failed?.code, 1, JSON.stringify(argv));
        if (argv[1] === bogus && argv.length === 2) {
          assert.match(failed?.stderr ?? '', /--no-such-flag|usage/);
        } else {
          assert.match(failed?.stderr ?? '', new RegExp(`^${command}: --argv-file`));
        }
      }
      assert.deepEqual(await disk.readdir(home, { recursive: true }), before);
    });
  }

  it('does not interpret option values or malformed mixed arguments as help', async () => {
    const home = await freshHome();
    const cases = [
      { command: 'squadron-spawn', argv: ['--prompt', '--help'], code: 3 },
      { command: 'squadron-rename', argv: ['--name', '--help'], code: 3 },
      { command: 'squadron-step', argv: ['unknown', '--help'], code: 1 },
      { command: 'squadron-step', argv: ['next', '--no-such-flag', '--help'], code: 1 },
      { command: 'squadron-send', argv: ['--no-such-flag', '--help'], code: 1 }
    ];
    for (const { command, argv, code } of cases) {
      const result = await run(process.execPath, [path.join(dist, `${command}.js`), ...argv], {
        cwd: home,
        env: { PATH: process.env.PATH ?? '', ...homeEnv(home) },
        timeout: 6000
      }).then(
        (value) => ({ code: 0, ...value }),
        (error: { code: number; stdout: string; stderr: string }) => error
      );
      assert.equal(result.code, code, JSON.stringify({ command, argv, result }));
      assert.equal(result.stdout, '');
      assert.ok(!result.stderr.includes('Related commands:'));
    }
  });
});

describe('bundled answer input', () => {
  let home: string;
  before(async () => {
    home = await freshHome();
  });

  async function invoke(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const result = await run(
        process.execPath,
        [
          path.join(repoRoot(), 'dist/squadron-answer.js'),
          '--pid',
          String(process.pid),
          '--request-id',
          'req-file',
          '--caller-session-id',
          'peer',
          ...argv
        ],
        { cwd: home, env: { ...process.env, ...homeEnv(home) }, timeout: 6000 }
      );
      return { code: 0, ...result };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  }

  it('rejects invalid sources as usage before host discovery and writes no request', async () => {
    const file = path.join(home, 'answers.json');
    const missing = path.join(home, 'missing.json');
    const cases: { argv: string[]; body?: Buffer }[] = [
      { argv: [] },
      { argv: ['--answers', '[]', '--answers-file', missing] },
      { argv: ['--answers-file', missing] },
      { argv: ['--answers-file', home] },
      ...[
        Buffer.from(''),
        Buffer.from('{broken'),
        Buffer.from([0xff]),
        Buffer.alloc(96 * 1024 + 1, 0x20)
      ].map((body) => ({ argv: ['--answers-file', file], body }))
    ];
    for (const { argv, body } of cases) {
      if (body) await disk.writeFile(file, body);
      const result = await invoke(argv);
      assert.equal(result.code, 1, JSON.stringify({ argv, result }));
      assert.equal(result.stdout, '');
      assert.deepEqual(
        await disk.readdir(path.join(home, '.squadron/requests')).catch(() => []),
        []
      );
    }
  });

  it(
    'refuses a FIFO without waiting for a writer',
    {
      skip:
        helpers.testPlatform() === 'win32' &&
        'win32: POSIX FIFO admission is a native filesystem control'
    },
    async () => {
      const fifo = path.join(home, 'answers.fifo');
      await run('mkfifo', [fifo]);
      const result = await invoke(['--answers-file', fifo]);
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /regular file/);
      assert.deepEqual(
        await disk.readdir(path.join(home, '.squadron/requests')).catch(() => []),
        []
      );
    }
  );

  it('posts identical attributed prose from inline, UTF-8 file and BOM file', async () => {
    const scan = await import('../../core/scan');
    const requests = await import('../../core/coordination/requests');
    const startedAt = (await scan.scanProcesses()).starts.get(process.pid);
    assert.ok(startedAt);
    const session = {
      pid: process.pid,
      startedAt,
      sessionId: 'question-owner',
      cwd: home,
      name: 'asker',
      source: 'owned',
      windowId: 'answer-window',
      status: 'waiting',
      hasCommand: false,
      updatedAt: Date.now(),
      transcript: ''
    };
    await helpers.writeLiveClaim(home, { id: 'answer-window' });
    await helpers.writeJson(path.join(home, '.claude/sessions', `${process.pid}.json`), {
      ...session,
      entrypoint: 'sdk-cli',
      procStart: helpers.procStartFor(startedAt)
    });
    await helpers.writeJson(path.join(home, '.squadron/live', `${process.pid}.json`), {
      schema: 1,
      session,
      liveText: '',
      queued: [],
      pending: [
        {
          requestId: 'req-file',
          toolName: 'AskUserQuestion',
          ask: true,
          questions: [{ question: 'Which database?', multiSelect: false, options: [] }]
        }
      ]
    });
    const words = '中文 😀 "quoted"\nnext line';
    const file = path.join(home, '答案 with spaces.json');
    for (const source of ['inline', 'file', 'bom']) {
      await disk.writeFile(
        file,
        (source === 'bom' ? '\ufeff' : '') + JSON.stringify([{ answer: words }], null, 2)
      );
      const posted: import('../../core/coordination/requests').Request[] = [];
      let finished = false;
      const running = invoke(
        source === 'inline'
          ? ['--answers', JSON.stringify([{ answer: words }])]
          : ['--answers-file', path.basename(file)]
      ).finally(() => {
        finished = true;
      });
      while (!finished) {
        await requests.claimRequests('answer-window', (request) => {
          posted.push(request);
          return { ok: true };
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const result = await running;
      assert.equal(result.code, 0, JSON.stringify({ source, result }));
      assert.equal(posted.length, 1);
      const request = posted[0];
      assert.equal(request?.kind, 'answer');
      assert.ok(request?.kind === 'answer');
      assert.equal(request.askId, 'req-file');
      assert.equal(request.from, 'peer');
      assert.equal(
        request.text,
        '<squadron-message from="peer">\n' +
          'Answers to the question you asked. Your dialog was closed so they could reach you; ' +
          'continue as if they had been picked there.\n' +
          String.raw`"Which database?"="中文 😀 \"quoted\"\nnext line"` +
          '\n</squadron-message>'
      );
    }
  });
});
