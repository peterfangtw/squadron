import {
  incomingPlatformFixture,
  resetPrivateFiles,
  privatePermissions
} from './incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { after, afterEach, before, beforeEach, it, mock } from 'node:test';
import type { FetchFileReply, ReceiverIdentity } from '../../core/bridge/model';
import type { PublishedLive } from '../../core/published';
import type { ProcessTable } from '../../core/scan';
import * as scan from '../../core/scan';
import * as rig from '../incoming_fetch_helpers';
import * as owners from './incoming_owner_helpers';
import {
  liveClaim,
  needsFileSymlinks,
  repoRoot,
  resetDir,
  tempHome,
  testPlatform
} from '../helpers';

const run = promisify(cp.execFile);
let paths: typeof import('../../core/paths');
let cli: typeof import('../../cli/self');
let requests: typeof import('../../core/coordination/requests');
let serve: typeof import('../../core/coordination/serve_owned');
let fetch: typeof import('../../core/remote/serve_fetch');
let cwd: string;
let command: string;
let temporary: string;
let previousTemp: Pick<NodeJS.ProcessEnv, 'TEMP' | 'TMP' | 'TMPDIR'>;
let claimDir: string;
const rigs: Awaited<ReturnType<typeof rig.make>>[] = [];
let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  const home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  paths = await import('../../core/paths');
  cli = await import('../../cli/self');
  requests = await import('../../core/coordination/requests');
  serve = await import('../../core/coordination/serve_owned');
  fetch = await import('../../core/remote/serve_fetch');
  cwd = path.join(home, "native folder's files");
  temporary = path.join(home, "temporary folder's files");
  await fs.mkdir(cwd);
  await fs.mkdir(temporary);
  cwd = await fs.realpath(cwd);
  temporary = await fs.realpath(temporary);
  previousTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: temporary, TMP: temporary, TMPDIR: temporary });
  mock.method(os, 'tmpdir', () => temporary);
  claimDir = (await import('../../core/coordination/claims')).WINDOWS_DIR;
  assert.ok(paths.SHIM_NAMES.includes('squadron-fetch-file'));
  await fs.mkdir(paths.BIN_DIR, { recursive: true });
  const platform = await import('../../core/platform');
  await platform.launchers.install(
    paths.BIN_DIR,
    'squadron-fetch-file',
    path.join(repoRoot(), 'dist/squadron-fetch-file.js')
  );
  await platform.launchers.installHelperLocator(paths.BIN_DIR, repoRoot());
  command = platform.launchers.scriptPath(paths.BIN_DIR, 'squadron-fetch-file');
});
beforeEach(async () => {
  for (const directory of [paths.CONVERSATIONS_DIR, paths.LIVE_DIR, paths.REQUESTS_DIR, claimDir])
    await resetDir(directory);
  await fs.rm(paths.HEARD_FILE, { force: true });
  await fs.rm(paths.HOLDER_FILE, { force: true });
  await fs.mkdir(claimDir, { recursive: true });
  await fs.writeFile(
    path.join(claimDir, 'destination.json'),
    JSON.stringify(liveClaim({ id: 'destination', label: 'test window', folder: cwd }))
  );
  await resetPrivateFiles();
});
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((t) => t.close()));
});
after(() => {
  for (const key of ['TEMP', 'TMP', 'TMPDIR'] as const) {
    if (previousTemp[key] === undefined) delete process.env[key];
    else process.env[key] = previousTemp[key];
  }
});

type ToolResult = { code: number; stdout: string; stderr: string };
async function tool(
  child: Awaited<ReturnType<typeof owners.child>>,
  shell: string,
  env?: NodeJS.ProcessEnv
): Promise<ToolResult> {
  const claimPath = path.join(claimDir, 'destination.json');
  const claim = await fs.readFile(claimPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (claim !== undefined) {
    const current = JSON.parse(claim) as Record<string, unknown>;
    await fs.writeFile(claimPath, JSON.stringify({ ...current, updatedAt: Date.now() }));
  }
  const result = path.join(cwd, `tool-${crypto.randomUUID()}.json`);
  assert.equal(
    (
      await child.route.messages!.send(
        `squadron-native-tool ${JSON.stringify({ command: shell, result, env })}`
      )
    ).ok,
    true
  );
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline) {
    const output = await fs.readFile(result, 'utf8').catch(() => undefined);
    if (output) {
      await owners.until(child.handle, (handle) => handle.state.status === 'idle');
      return JSON.parse(output) as ToolResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('native tool did not finish');
}

async function make(brand: 'claude' | 'grok' | 'codex') {
  const t = await rig.make(cwd, { brand });
  rigs.push(t);
  t.send();
  await t.drain();
  const view = await t.view();
  const child = t.started[0]!;
  await child.publish();
  await fs.mkdir(path.dirname(paths.HOLDER_FILE), { recursive: true });
  await fs.writeFile(
    paths.HOLDER_FILE,
    JSON.stringify({
      windowId: t.holder.host.windowId,
      label: 'fake holder',
      pid: t.holder.host.pid,
      startedAt: t.holder.host.osStartedAt,
      since: Date.now(),
      incoming: t.holder
    })
  );
  let transform: (reply: FetchFileReply) => unknown = (reply) => reply;
  let silent = false;
  let malformed = false;
  const seen: import('../../core/coordination/requests').Request[] = [];
  const handlerFailures: string[] = [];
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void requests
      .claimRequests(t.holder.host.windowId, async (request) => {
        seen.push(request);
        if (request.kind === 'fetchFile') {
          if (silent) return new Promise(() => {});
          if (malformed)
            return {
              unknown: 'reply'
            } as unknown as import('../../core/coordination/requests').Reply;
          const reply = await fetch.serveFetchFile(request, t.files);
          let transformed: unknown;
          try {
            transformed = await transform(reply.fetchFile!);
          } catch (error) {
            handlerFailures.push(String(error));
            throw error;
          }
          return {
            ...reply,
            ok:
              !!transformed &&
              typeof transformed === 'object' &&
              'kind' in transformed &&
              transformed.kind === 'fetched',
            fetchFile: transformed
          } as import('../../core/coordination/requests').Reply;
        }
        return serve.serveOwned(request, t.port) ?? { ok: false };
      })
      .finally(() => {
        running = false;
      });
  }, 20);
  const shell = paths.verbCommand(
    testPlatform() === 'win32' ? 'windows-powershell' : 'posix',
    'squadron-fetch-file',
    '--conversation-id',
    view.conversation,
    '--message-id',
    view.correlation,
    '--file-id',
    'file-0'
  );
  return {
    t,
    child,
    view,
    shell,
    seen,
    handlerFailures,
    stop: () => clearInterval(timer),
    transform(next: typeof transform) {
      transform = next;
    },
    silence() {
      silent = true;
    },
    malformed(value: boolean) {
      malformed = value;
    }
  };
}

for (const brand of ['claude', 'grok', 'codex'] as const)
  it(
    `${brand}: installed fetch crosses native shell, owner challenge and holder files; hits and refetches`,
    {},
    async () => {
      const r = await make(brand);
      try {
        const first = await tool(
          r.child,
          r.shell,
          brand === 'claude'
            ? {}
            : {
                CLAUDE_PID: '999999',
                CLAUDE_CODE_SESSION_ID: 'leaked-ancestor'
              }
        );
        assert.equal(first.code, 0, first.stderr);
        const reply = JSON.parse(first.stdout) as Extract<FetchFileReply, { kind: 'fetched' }>;
        assert.equal(reply.identity.receiver.pid, r.child.pid);
        assert.equal(await fs.readFile(reply.path, 'utf8'), 'actual local bytes');
        assert.equal(r.t.calls.filter((call) => call.startsWith('download:')).length, 1);
        assert.equal((await tool(r.child, r.shell)).code, 0);
        assert.equal(r.t.calls.filter((call) => call.startsWith('download:')).length, 1);
        await fs.unlink(reply.path);
        r.t.bytes(rig.PNG_BYTES);
        const refetched = await tool(r.child, r.shell);
        assert.equal(refetched.code, 0, refetched.stderr);
        const image = JSON.parse(refetched.stdout) as Extract<FetchFileReply, { kind: 'fetched' }>;
        assert.equal(path.extname(image.path), '.png');
        assert.deepEqual(await fs.readFile(image.path), rig.PNG_BYTES);
        assert.equal(r.t.calls.filter((call) => call.startsWith('download:')).length, 2);
        const before = r.seen.filter((request) => request.kind === 'fetchFile').length;
        const spelling = (await import('../../core/identity')).IDENTITY_ENV[brand];
        const stale = await tool(r.child, r.shell, { [spelling.id]: 'stale-inherited-id' });
        assert.equal(stale.code, 2, stale.stderr);
        assert.equal(stale.stdout, '');
        assert.equal(r.seen.filter((request) => request.kind === 'fetchFile').length, before);
        if (brand === 'claude') {
          assert.equal((await tool(r.child, r.shell, { CLAUDE_PID: '999999' })).code, 2);
          assert.equal(r.seen.filter((request) => request.kind === 'fetchFile').length, before);
        }
        const replacement = await owners.child(
          r.t.host,
          brand,
          cwd,
          r.child.handle.state.sessionId
        );
        r.t.started.push(replacement);
        await replacement.publish();
        assert.equal(replacement.handle.state.sessionId, r.child.handle.state.sessionId);
        const other = await tool(replacement, r.shell);
        assert.equal(other.code, 2, other.stderr);
        const last = r.seen.filter((request) => request.kind === 'fetchFile').at(-1)!;
        assert.equal(last.receiver.pid, replacement.pid);
        assert.equal(other.stdout, '');
        await r.child.close();
        assert.equal((await tool(replacement, r.shell)).code, 2);
        assert.ok(
          r.seen.every((request) => ['incomingEvidenceV1', 'fetchFile'].includes(request.kind))
        );
      } finally {
        r.stop();
      }
    }
  );

it(
  'clear keeps the receiver lifetime, refuses stale tool IDs and permits current-session retry',
  {},
  async () => {
    const r = await make('claude');
    try {
      const old = r.child.handle.state.sessionId;
      assert.equal((await r.child.route.messages!.send('conversation-reset-probe')).ok, true);
      await owners.until(
        r.child.handle,
        (handle) => handle.state.sessionId !== old && handle.state.status === 'idle'
      );
      const result = await tool(r.child, r.shell);
      assert.equal(result.code, 0, result.stderr);
      const reply = JSON.parse(result.stdout) as FetchFileReply;
      assert.deepEqual(reply.identity.receiver, r.child.owner.receiverIdentity);
      assert.equal(reply.identity.currentSessionId, r.child.handle.state.sessionId);
      assert.equal((await tool(r.child, r.shell, { CLAUDE_CODE_SESSION_ID: old })).code, 2);
    } finally {
      r.stop();
    }
  }
);

it(
  'installed native fetch accepts concurrent renewal of the same bytes while its reply is withheld',
  {},
  async () => {
    const r = await make('codex');
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let receive: (reply: Extract<FetchFileReply, { kind: 'fetched' }>) => void = () => {};
    const received = new Promise<Extract<FetchFileReply, { kind: 'fetched' }>>((resolve) => {
      receive = resolve;
    });
    r.transform(async (reply) => {
      if (reply.kind !== 'fetched') return reply;
      receive(reply);
      await held;
      return reply;
    });
    const pending = tool(r.child, r.shell);
    try {
      const original = await Promise.race([
        received,
        pending.then((result) => {
          throw new Error(`CLI finished before its held reply: ${result.stderr}`);
        })
      ]);
      const renewed = await r.t.fetch(r.t.identity(r.view, r.child));
      assert.equal(renewed.kind, 'fetched');
      assert.ok(renewed.kind === 'fetched');
      assert.equal(renewed.path, original.path);
      assert.ok(renewed.expiresAt > original.expiresAt);
      assert.equal(r.t.calls.filter((call) => call.startsWith('download:')).length, 1);
      release();
      const result = await pending;
      assert.equal(result.code, 0, result.stderr);
      const returned = JSON.parse(result.stdout) as FetchFileReply;
      assert.deepEqual(returned, original);
    } finally {
      release();
      await pending;
      r.stop();
    }
  }
);

it('installed exits and exact typed reply/path controls', {}, async () => {
  const r = await make('codex');
  try {
    for (const flag of ['pid', 'target', 'url', 'token', 'output-path', 'caller']) {
      const failed = await run(process.execPath, [command, `--${flag}`, 'x']).then(
        () => undefined,
        (error: { code: number; stdout: string }) => error
      );
      assert.equal(failed?.code, 1);
      assert.equal(failed.stdout, '');
    }
    assert.equal((await tool(r.child, r.shell)).code, 0);
    r.malformed(true);
    assert.equal((await tool(r.child, r.shell)).code, 5);
    r.malformed(false);
    r.transform((reply) => ({ ...reply, requestId: crypto.randomUUID() }));
    assert.equal((await tool(r.child, r.shell)).code, 5);
    r.transform((reply) => ({ ...reply, identity: { ...reply.identity, fileId: 'other' } }));
    assert.equal((await tool(r.child, r.shell)).code, 5);
    r.transform((reply) => ({ ...reply, cacheKey: 'other_key' }));
    assert.equal((await tool(r.child, r.shell)).code, 2);
    r.transform((reply) => ({ ...reply, kind: 'future-arm' }));
    assert.equal((await tool(r.child, r.shell)).code, 5);
    r.transform((reply) => ({ ...reply, bytes: -1 }));
    assert.equal((await tool(r.child, r.shell)).code, 5);
    r.transform((reply) => ({
      ...reply,
      identity: {
        ...reply.identity,
        receiver: {
          ...reply.identity.receiver,
          incarnation: crypto.randomUUID()
        }
      }
    }));
    assert.equal((await tool(r.child, r.shell)).code, 5);
    r.transform((reply) => ({ ...reply, kind: 'pending', retryable: true }));
    assert.equal((await tool(r.child, r.shell)).code, 4);
    r.transform((reply) => ({ ...reply, kind: 'refused', code: 'timeout' }));
    assert.equal((await tool(r.child, r.shell)).code, 4);
    r.transform((reply) => ({ ...reply, kind: 'refused', code: 'wrong-receiver' }));
    assert.equal((await tool(r.child, r.shell)).code, 2);
    r.transform((reply) => ({ ...reply, expiresAt: Date.now() - 1 }));
    assert.equal((await tool(r.child, r.shell)).code, 2);
    r.transform((reply) => ({
      ...reply,
      path: `${reply.kind === 'fetched' ? reply.path : ''}.png.exe`
    }));
    const badSuffix = await tool(r.child, r.shell);
    assert.equal(badSuffix.code, 2);
    assert.equal(badSuffix.stdout, '');
    r.transform(async (reply) => {
      assert.equal(reply.kind, 'fetched');
      if (reply.kind !== 'fetched') return reply;
      await privatePermissions(reply.path, false);
      return reply;
    });
    const unsafe = await tool(r.child, r.shell);
    assert.equal(unsafe.code, 2, `${unsafe.stderr}\n${r.handlerFailures.join('\n')}`);
    assert.equal(unsafe.stdout, '');
    // The holder refuses these damaged bytes too; remove them before the next independent control.
    const bytesFile = (await fs.readdir(r.t.capability.localRoot)).find((name) =>
      name.endsWith('.bytes')
    )!;
    const cached = path.join(r.t.capability.localRoot, bytesFile);
    await privatePermissions(cached, true);
    r.transform(async (reply) => {
      assert.equal(reply.kind, 'fetched');
      if (reply.kind !== 'fetched') return reply;
      await fs.unlink(reply.path);
      if (needsFileSymlinks()) await fs.mkdir(reply.path);
      else await fs.symlink(path.join(cwd, 'unrelated.txt'), reply.path);
      return reply;
    });
    await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'unrelated');
    assert.equal((await tool(r.child, r.shell)).code, 2);
    if ((await fs.lstat(cached)).isDirectory()) await fs.rmdir(cached);
    else await fs.unlink(cached);
    r.transform((reply) => reply);
    assert.equal((await tool(r.child, r.shell)).code, 0);
    const evidence = r.t.port.evidence!.bind(r.t.port);
    r.t.port.evidence = async (...input) => {
      const proof = await evidence(...input);
      return proof && { ...proof, challenge: crypto.randomUUID() };
    };
    const before = r.seen.filter((request) => request.kind === 'fetchFile').length;
    assert.equal((await tool(r.child, r.shell)).code, 2);
    assert.equal(r.seen.filter((request) => request.kind === 'fetchFile').length, before);
    r.t.port.evidence = evidence;
    r.transform((asyncReply) => {
      assert.equal(asyncReply.kind, 'fetched');
      return { ...asyncReply, path: cwd, localRoot: path.dirname(cwd) };
    });
    assert.equal((await tool(r.child, r.shell)).code, 2);
    r.transform((reply) => reply);
    await resetDir(claimDir);
    assert.equal((await tool(r.child, r.shell)).code, 3);
    await fs.mkdir(claimDir, { recursive: true });
    await fs.writeFile(
      path.join(claimDir, 'destination.json'),
      JSON.stringify(liveClaim({ id: 'destination', label: 'test' }))
    );
    await resetDir(paths.REQUESTS_DIR);
    await fs.writeFile(paths.REQUESTS_DIR, 'not a directory');
    assert.equal((await tool(r.child, r.shell)).code, 5);
    await fs.unlink(paths.REQUESTS_DIR);
  } finally {
    r.stop();
  }
});

it(
  'installed fetch waits 60 seconds for an unanswered holder and reports retryable pending',
  { timeout: 75_000 },
  async () => {
    const r = await make('grok');
    try {
      r.silence();
      const at = performance.now();
      const result = await tool(r.child, r.shell);
      assert.equal(result.code, 4, result.stderr);
      assert.equal(result.stdout, '');
      assert.ok(performance.now() - at >= 60_000);
      assert.equal(r.seen.filter((request) => request.kind === 'fetchFile').length, 1);
      assert.equal(r.t.calls.length, 0);
    } finally {
      r.stop();
    }
  }
);

it('bounded topology refuses incomplete, looping, missing, replaced and unowned barriers; chooses nested self', () => {
  const host = {
    version: 1 as const,
    windowId: 'native',
    pid: 10,
    osStartedAt: 1000,
    startSource: 'ps-lstart-v1' as const,
    incarnation: crypto.randomUUID()
  };
  const receiver: ReceiverIdentity = {
    version: 1,
    host,
    pid: 20,
    osStartedAt: 2000,
    startSource: 'ps-lstart-v1',
    incarnation: crypto.randomUUID(),
    brand: 'codex',
    cwd: path.resolve('/native')
  };
  const record = (identity: ReceiverIdentity): PublishedLive => ({
    schema: 1,
    receiverIdentity: identity,
    pending: [],
    queued: [],
    session: {
      pid: identity.pid,
      sessionId: 'same-id',
      startedAt: identity.osStartedAt,
      cwd: identity.cwd,
      name: '',
      transcript: '',
      updatedAt: 0,
      status: 'idle',
      hasCommand: false,
      source: 'owned',
      windowId: identity.host.windowId,
      brand: identity.brand
    }
  });
  const table = (): ProcessTable => ({
    complete: true,
    startSource: 'ps-lstart-v1',
    parents: new Map([
      [30, 20],
      [20, 10],
      [10, 1]
    ]),
    starts: new Map([
      [30, 3000],
      [20, 2000],
      [10, 1000]
    ]),
    codex: new Map(),
    grok: new Map(),
    claude: new Map(),
    groups: new Map(),
    shellParents: new Set()
  });
  const records = new Map([[20, record(receiver)]]);
  assert.deepEqual(cli.nearestOwnedReceiver(30, table(), records), receiver);
  const invalid = [
    (t: ProcessTable) => {
      t.complete = false;
    },
    (t: ProcessTable) => {
      delete t.startSource;
    },
    (t: ProcessTable) => {
      t.parents.set(30, 30);
    },
    (t: ProcessTable) => {
      t.parents.delete(30);
    },
    (t: ProcessTable) => {
      t.starts.delete(30);
    },
    (t: ProcessTable) => {
      t.starts.set(20, 999);
    },
    (t: ProcessTable) => {
      t.starts.set(10, 999);
    },
    (t: ProcessTable) => {
      t.starts.set(30, 100);
    },
    (t: ProcessTable) => {
      t.codex.set(30, { pid: 30, ppid: 20, startedAt: 3000, command: 'codex app-server' });
    }
  ];
  for (const breakTable of invalid) {
    const t = table();
    breakTable(t);
    assert.equal(cli.nearestOwnedReceiver(30, t, records), undefined);
  }
  for (const hostStart of [2000, 4000]) {
    const observed = scan.tableOf({
      supported: true,
      status: 'ok',
      value: {
        source: 'ps-lstart-v1',
        rows: [
          { pid: 30, ppid: 20, startedAt: 5000, command: 'node tool' },
          { pid: 20, ppid: 10, startedAt: 2000, command: 'codex app-server' },
          { pid: 10, ppid: 1, startedAt: hostStart, command: 'node host' }
        ]
      }
    });
    const exact = { ...receiver, host: { ...host, osStartedAt: hostStart } };
    assert.deepEqual(
      cli.nearestOwnedReceiver(30, observed, new Map([[20, record(exact)]])),
      hostStart === 2000 ? exact : undefined,
      'the final receiver-host edge must obey chronology with all published identities matching'
    );
  }
  const nested = {
    ...receiver,
    pid: 40,
    osStartedAt: 4000,
    incarnation: crypto.randomUUID(),
    host: { ...host, pid: 30, osStartedAt: 3000, incarnation: crypto.randomUUID() }
  };
  const t = table();
  t.parents.set(50, 40);
  t.starts.set(50, 5000);
  t.parents.set(40, 30);
  t.starts.set(40, 4000);
  records.set(40, record(nested));
  assert.deepEqual(cli.nearestOwnedReceiver(50, t, records), nested);
  records.set(40, { ...record(nested), receiverIdentity: { ...nested, incarnation: 'invalid' } });
  assert.equal(cli.nearestOwnedReceiver(50, t, records), undefined);
  const deep = table();
  for (let pid = 1000; pid >= 800; pid--) {
    deep.parents.set(pid, pid - 1);
    deep.starts.set(pid, pid);
  }
  assert.equal(cli.nearestOwnedReceiver(1000, deep, records), undefined);
});
