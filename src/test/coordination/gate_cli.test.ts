import * as assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { ORCHESTRATION_OFF, VERBS } from '../../core/verbs';
import * as helpers from '../helpers';

/**
 * Orchestration's gate, as the shipped bundles run it: a claim file in a temp
 * home, valid flags, and the switch on, off or unreadable. With the switch on
 * each verb goes on to the outcome its fixture reaches past the gate (no such
 * pid, no caller, or the request it posts), and that outcome is asserted, so
 * an exit before the gate cannot pass as admission.
 */

const dist = path.join(helpers.repoRoot(), 'dist');
const WINDOW = 'w-gate';

/** Flags each verb accepts, so a refusal is the gate's and not usage. */
const FLAGS: Record<string, string[]> = {
  send: ['--pid', '1', '--text', 'hello'],
  answer: ['--pid', '1', '--request-id', 'req_1', '--answers', '[{"answer":"yes"}]'],
  spawn: ['--prompt', 'hello'],
  end: ['--pid', '1'],
  rename: ['--pid', '1', '--name', 'card'],
  warm: ['--pid', '1'],
  wait: ['--pids', '1'],
  step: ['next'],
  attach: ['--file-path', 'note.txt'],
  'fetch-file': ['--conversation-id', 'c1', '--message-id', 'm1', '--file-id', 'f1'],
  list: [],
  models: []
};

/**
 * Where each write verb's fixture ends with the switch on: its own refusal's
 * first stderr line (exit 2), or the kind of request it posts.
 */
const PAST_GATE: Record<string, { refused: string } | { posts: string }> = {
  send: {
    refused:
      'squadron-send: cannot tell which session is asking; pass --caller-session-id <sessionId>'
  },
  answer: {
    refused:
      'squadron-answer: cannot tell which session is asking; pass --caller-session-id <sessionId>'
  },
  spawn: { posts: 'open' },
  end: { refused: 'squadron-end: no session Squadron sees has pid 1' },
  rename: { refused: 'squadron-rename: no session on the board has pid 1' },
  warm: { refused: 'squadron-warm: no session on the board has pid 1' },
  wait: {
    refused:
      'squadron-wait: cannot tell which session is asking; pass --caller-session-id <sessionId>'
  },
  step: {
    refused:
      'squadron-step: this command could not tell which session is calling it; pass --caller-session-id <sessionId>'
  },
  attach: {
    refused:
      'squadron-attach: cannot tell which session is asking; nothing in this environment names one'
  },
  'fetch-file': { refused: 'squadron-fetch-file: cannot prove the nearest owned CLI ancestor' }
};

const made: string[] = [];
after(async () => {
  for (const home of made.splice(0)) await helpers.disposeHome(home);
});

/** A home with one live claim, or none when `orchestration` is `'none'`. */
async function home(orchestration: boolean | 'none'): Promise<string> {
  const at = await helpers.tempHome();
  made.push(at);
  await fs.writeFile(path.join(at, 'note.txt'), 'note');
  if (orchestration !== 'none') {
    const windows = path.join(at, '.squadron', 'windows');
    await fs.mkdir(windows, { recursive: true });
    await fs.writeFile(
      path.join(windows, `${WINDOW}.json`),
      JSON.stringify({
        id: WINDOW,
        label: 'acme-web',
        app: 'VS Code',
        shellPids: [],
        orchestration,
        updatedAt: Date.now()
      })
    );
  }
  return at;
}

const WRITTEN = ['requests', 'waits', 'runs'];

async function written(at: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of WRITTEN) {
    const names = await fs.readdir(path.join(at, '.squadron', dir)).catch(() => []);
    found.push(...names.map((name) => `${dir}/${name}`));
  }
  return found;
}

/** `kind` of the request a verb posted, when it posted one before being killed. */
type Ran = { code: number | null; stderr: string; asked?: string };

/**
 * Runs `squadron-<verb>` until it exits, or until it has posted a request —
 * a verb past the gate that asks a window then waits for a reply no window
 * here will write, so it is killed there.
 */
async function run(verb: string, at: string): Promise<Ran> {
  const child = cp.spawn(
    process.execPath,
    [path.join(dist, `squadron-${verb}.js`), ...(FLAGS[verb] ?? [])],
    {
      cwd: at,
      env: { PATH: process.env.PATH ?? '', ...helpers.homeEnv(at), SQUADRON_ORIGIN_WINDOW: WINDOW }
    }
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  const requests = path.join(at, '.squadron', 'requests');
  const deadline = Date.now() + 20_000;
  for (;;) {
    const code = await Promise.race([
      exited,
      new Promise<'poll'>((r) => setTimeout(() => r('poll'), 50))
    ]);
    if (code !== 'poll') return { code, stderr };
    const posted = await postedKind(requests);
    if (posted !== undefined || Date.now() > deadline) {
      child.kill('SIGKILL');
      await exited;
      assert.ok(posted !== undefined, `squadron-${verb} neither exited nor asked within 20 s`);
      return { code: null, stderr, asked: posted };
    }
  }
}

/** The `kind` of the first request file that has been written whole. */
async function postedKind(requests: string): Promise<string | undefined> {
  for (const name of await fs.readdir(requests).catch(() => [])) {
    try {
      const body = JSON.parse(await fs.readFile(path.join(requests, name), 'utf8')) as {
        kind?: unknown;
      };
      if (typeof body.kind === 'string') return body.kind;
    } catch {
      // Still being written; the next poll reads it whole.
    }
  }
  return undefined;
}

describe('Orchestration gate over the shipped verbs', () => {
  const writes = VERBS.filter((v) => v.write).map((v) => v.name);
  const reads = VERBS.filter((v) => !v.write).map((v) => v.name);

  for (const verb of writes) {
    it(`squadron-${verb} refuses with the switch off and writes nothing`, async () => {
      const at = await home(false);
      const ran = await run(verb, at);
      assert.equal(ran.code, 2, ran.stderr);
      assert.equal(ran.stderr, `squadron-${verb}: ${ORCHESTRATION_OFF}\n`);
      assert.deepEqual(await written(at), []);
    });

    it(`squadron-${verb} passes the gate with the switch on`, async () => {
      const ran = await run(verb, await home(true));
      const past = PAST_GATE[verb];
      assert.ok(past, `no PAST_GATE row for ${verb}`);
      if ('posts' in past) {
        assert.equal(ran.asked, past.posts, `exit ${String(ran.code)}: ${ran.stderr}`);
      } else {
        assert.equal(ran.code, 2, ran.stderr);
        assert.equal(ran.stderr.split('\n')[0], past.refused);
      }
    });

    it(`squadron-${verb} exits 3 with no live window`, async () => {
      const ran = await run(verb, await home('none'));
      assert.equal(ran.code, 3, ran.stderr);
    });
  }

  for (const verb of reads) {
    it(`squadron-${verb} runs with the switch off`, async () => {
      const ran = await run(verb, await home(false));
      assert.ok(!ran.stderr.includes(ORCHESTRATION_OFF), ran.stderr);
      assert.ok(
        ran.asked !== undefined || ran.code === 0,
        `exit ${String(ran.code)}: ${ran.stderr}`
      );
    });
  }
});
