import { incomingPlatformFixture } from './incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, it } from 'node:test';
import * as fixtures from './incoming_owner_helpers';
import { tempHome } from '../helpers';
import type { Reply } from '../../core/coordination/requests';
import type { ReceiverIdentity } from '../../core/bridge/model';

let ownership: typeof import('../../core/owned_incoming');
let published: typeof import('../../core/published');
let serve: typeof import('../../core/coordination/serve_owned');
let requests: typeof import('../../core/coordination/requests');
let scan: typeof import('../../core/scan');
let paths: typeof import('../../core/paths');
let cwd: string;
let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  const home = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(home);
  ownership = await import('../../core/owned_incoming');
  published = await import('../../core/published');
  serve = await import('../../core/coordination/serve_owned');
  requests = await import('../../core/coordination/requests');
  scan = await import('../../core/scan');
  paths = await import('../../core/paths');
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'incoming-owner-')));
});

for (const boundary of ['capture', 'evidence'] as const) {
  it(
    `${boundary} refuses a refuted native parent while exact identity and pipe guards match`,
    {},
    async (t) => {
      const platform = await import('../../core/platform');
      const realHost = new ownership.IncomingHost('w-relation');
      const child = await fixtures.child(realHost, 'claude', cwd);
      t.diagnostic(`incoming ${boundary} fixture PID: ${child.pid}`);
      let childStart = 2000;
      t.mock.method(platform.processes, 'snapshot', () =>
        Promise.resolve({
          supported: true as const,
          status: 'ok' as const,
          value: {
            source: 'ps-lstart-v1' as const,
            rows: [
              { pid: child.pid, ppid: process.pid, startedAt: childStart, command: 'claude' },
              { pid: process.pid, ppid: 1, startedAt: 2000, command: 'node host' }
            ]
          }
        })
      );
      try {
        const host = new ownership.IncomingHost('w-relation');
        const capability = await host.capability();
        assert.ok(capability);
        for (childStart of [2000, 1000]) {
          if (boundary === 'capture') {
            const captured = await host.capture(
              child.transport,
              child.handle,
              'claude',
              () => true
            );
            assert.equal(captured !== undefined, childStart === 2000);
          } else {
            // Exercise a retained receiver independently of admission, with every
            // current identity matching the supplied native snapshot.
            const receiver: ReceiverIdentity = {
              ...child.owner.receiverIdentity,
              host: capability.host,
              osStartedAt: childStart,
              startSource: 'ps-lstart-v1'
            };
            const retained = new ownership.OwnedIncoming(
              receiver,
              child.transport,
              child.handle,
              () => true
            );
            const proof = await retained.evidence(
              crypto.randomUUID(),
              { kind: 'receiver', receiver },
              () => Promise.resolve(true)
            );
            assert.equal(proof !== undefined, childStart === 2000);
          }
          const table = await scan.scanProcesses(true);
          assert.equal(table.parents.has(child.pid), true);
          assert.equal(table.starts.get(child.pid), childStart);
        }
      } finally {
        await child.close();
        t.diagnostic(`incoming ${boundary} fixture closed before teardown completed: ${child.pid}`);
      }
    }
  );
}

for (const brand of ['claude', 'grok', 'codex'] as const) {
  it(
    `${brand}: mints native owner evidence and acknowledges the prepared marker before the only original prompt`,
    {},
    async () => {
      const host = new ownership.IncomingHost(`w-${brand}`);
      const capability = await host.capability();
      assert.ok(capability);
      let created: Awaited<ReturnType<typeof fixtures.child>> | undefined;
      const holder = { host: capability.host, generation: 1 };
      const attempt: import('../../core/bridge/model').LaunchAttempt = {
        version: 1,
        attemptId: crypto.randomUUID(),
        conversation: 'conversation',
        messageId: 'original',
        correlation: 'correlation',
        admissionDigest: 'a'.repeat(64),
        host: capability.host,
        cwd,
        target: { brand },
        selection: 'default',
        holder,
        createdAt: Date.now()
      };
      const starts = new ownership.IncomingLaunches();
      let sent = 0;
      const start = fixtures.files(attempt, capability.localRoot);
      const create = async (): Promise<Reply> => {
        const child = await fixtures.child(host, brand, cwd);
        created = child;
        const result = await child.owner.start(
          attempt,
          async () => {
            const marker = (await published.readPublished()).get(child.pid)?.remoteLaunchEvidence;
            assert.equal(marker?.stage, 'prepared');
            assert.equal(
              child.handle.state.messageFacts?.some(
                (fact) => fact.correlation === attempt.correlation
              ) ?? false,
              false
            );
            sent++;
            return child.route.messages!.send(
              start.prompt,
              undefined,
              undefined,
              undefined,
              undefined,
              attempt.correlation
            );
          },
          child.publish,
          () => Promise.resolve(true)
        );
        return result.ok
          ? {
              ok: true,
              pid: child.pid,
              startedAt: child.startedAt,
              brand,
              sessionId: child.handle.state.sessionId,
              remoteLaunchEvidence: child.owner.snapshot().remoteLaunchEvidence
            }
          : { ...result, reason: 'failed' };
      };
      const port: import('../../core/coordination/serve_owned').ServePort = {
        owned: (pid) => (pid === created?.pid ? created?.handle : undefined),
        end: () => false,
        start: () => {
          throw new Error('incoming request reached text start');
        },
        incomingAccess: () => host.capability(),
        holder: () =>
          Promise.resolve({
            windowId: capability.host.windowId,
            label: 'holder',
            pid: process.pid,
            startedAt: capability.host.osStartedAt,
            since: Date.now(),
            incoming: holder
          }),
        incomingHolder: () => port.holder(),
        incomingStarts: starts,
        startFiles: () => create(),
        evidence: (challenge, query) =>
          created?.owner.evidence(challenge, query, created.publish) ?? Promise.resolve(undefined)
      };
      try {
        const body = {
          ...start,
          kind: 'remoteStartFilesV1' as const,
          windowId: capability.host.windowId
        };
        if (brand === 'claude') {
          for (const changed of [
            {
              ...body,
              expectedHost: {
                ...body.expectedHost,
                osStartedAt: body.expectedHost.osStartedAt + 1000
              },
              attempt: {
                ...attempt,
                host: { ...attempt.host, osStartedAt: attempt.host.osStartedAt + 1000 }
              }
            },
            { ...body, localRoot: cwd },
            { ...body, attempt: { ...attempt, holder: { ...holder, generation: 2 } } }
          ]) {
            // Direct dispatch exercises the serving guard, before creation.
            const refused = await serve.serveOwned(
              {
                ...changed,
                attempt: { ...changed.attempt, attemptId: crypto.randomUUID() },
                id: crypto.randomUUID(),
                createdAt: Date.now()
              },
              port
            );
            assert.equal(refused?.ok, false);
            assert.equal(
              refused?.outcome,
              changed.expectedHost.osStartedAt === capability.host.osStartedAt
                ? 'stopped'
                : 'unknown'
            );
            assert.equal(created, undefined);
          }
        }
        const file = await requests.postRequest(body);
        assert.ok(file);
        let reply: Reply | undefined;
        await requests.claimRequests(capability.host.windowId, async (request) => {
          reply = await serve.serveOwned(request, port);
          return reply ?? { ok: false };
        });
        assert.equal(reply?.ok, true);
        assert.ok(created);
        const child = created;
        const [duplicate, concurrent] = await Promise.all([
          starts.run(start, create),
          starts.run(start, create)
        ]);
        assert.deepEqual(duplicate, reply);
        assert.deepEqual(concurrent, reply);
        assert.equal(sent, 1);
        assert.equal((await starts.run({ ...start, prompt: 'conflict' }, create)).ok, false);
        const receiver = child.owner.receiverIdentity;
        const table = await scan.scanProcesses(true);
        assert.equal(receiver.osStartedAt, table.starts.get(child.pid));
        assert.equal(receiver.host.osStartedAt, table.starts.get(process.pid));
        assert.equal(table.parents.get(child.pid), process.pid);
        const proof = await child.owner.evidence(
          crypto.randomUUID(),
          { kind: 'attempt', attempt },
          child.publish
        );
        assert.equal(proof?.launch?.stage, 'accepted');
        assert.deepEqual(proof?.receiver, receiver);
        assert.ok(
          Buffer.byteLength(
            JSON.stringify({
              revision: 3,
              state: 'active',
              attempt,
              execution: 'launched',
              receiver
            })
          ) +
            Buffer.byteLength(JSON.stringify(proof?.launch)) <
            48 * 1024
        );
      } finally {
        await created?.close();
      }
    }
  );
}

it(
  'failed required publication cannot send; a lost accepted write repairs through evidence without another prompt',
  {},
  async (context) => {
    const host = new ownership.IncomingHost('w-failure');
    const capability = await host.capability();
    assert.ok(capability);
    const holder = { host: capability.host, generation: 1 };
    const child = await fixtures.child(host, 'claude', cwd);
    const attempt = fixtures.attempt(child.owner, holder);
    const open = fs.open;
    let fail = true;
    context.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (fail && args[0] === paths.LIVE_DIR)
        context.mock.method(handle, 'sync', () =>
          Promise.reject(new Error('required directory flush failed'))
        );
      return handle;
    });
    let sent = 0;
    try {
      assert.deepEqual(
        await child.owner.start(
          attempt,
          () => {
            sent++;
            return Promise.resolve({ ok: true });
          },
          child.publish,
          () => Promise.resolve(true)
        ),
        { ok: false, outcome: 'stopped' }
      );
      assert.equal(sent, 0);
      assert.equal(await child.transport.exited, true);
      assert.equal(
        await child.owner.evidence(
          crypto.randomUUID(),
          { kind: 'attempt', attempt },
          child.publish
        ),
        undefined
      );
    } finally {
      fail = false;
      await child.close();
    }
    context.mock.restoreAll();
    const accepted = await fixtures.child(host, 'claude', cwd);
    const next = fixtures.attempt(accepted.owner, holder);
    try {
      const write = (): Promise<boolean> => {
        if (accepted.owner.snapshot().remoteLaunchEvidence?.stage === 'accepted' && fail)
          return Promise.resolve(false);
        return accepted.publish();
      };
      fail = true;
      assert.deepEqual(
        await accepted.owner.start(
          next,
          () => {
            sent++;
            return accepted.route.messages!.send(
              'inspect it',
              undefined,
              undefined,
              undefined,
              undefined,
              next.correlation
            );
          },
          write,
          () => Promise.resolve(true)
        ),
        { ok: false, outcome: 'unknown' }
      );
      fail = false;
      const proof = await accepted.owner.evidence(
        crypto.randomUUID(),
        { kind: 'attempt', attempt: next },
        write
      );
      assert.equal(proof?.launch?.stage, 'accepted');
      assert.equal(sent, 1);
      assert.equal(
        (await published.readPublished()).get(accepted.pid)?.remoteLaunchEvidence?.stage,
        'accepted'
      );
    } finally {
      await accepted.close();
    }
  }
);

it(
  'exact start, current registry entry, activation nonce and native close reject tolerant or coarse PID reuse',
  {},
  async (context) => {
    const host = new ownership.IncomingHost('w-native');
    const first = await host.capability();
    assert.ok(first);
    const child = await fixtures.child(host, 'claude', cwd);
    try {
      const receiver = child.owner.receiverIdentity;
      const query = { kind: 'receiver' as const, receiver };
      assert.ok(await child.owner.evidence(crypto.randomUUID(), query, child.publish));
      const table = await scan.scanProcesses(true);
      const original = scan.scanProcesses;
      let override: import('../../core/scan').ProcessTable | undefined;
      context.mock.method(scan, 'scanProcesses', (fresh?: boolean) =>
        override ? Promise.resolve(override) : original(fresh)
      );
      for (const pid of [child.pid, process.pid]) {
        override = {
          ...table,
          starts: new Map(
            [...table.starts].map(([id, start]) => [id, id === pid ? start + 1000 : start])
          )
        };
        assert.equal(
          await child.owner.evidence(crypto.randomUUID(), query, child.publish),
          undefined
        );
        override = undefined;
      }
      const second = await new ownership.IncomingHost('w-native').capability();
      assert.ok(second);
      assert.equal(second.host.pid, first.host.pid);
      assert.equal(second.host.osStartedAt, first.host.osStartedAt);
      assert.notEqual(second.host.incarnation, first.host.incarnation);
      assert.equal(
        await child.owner.evidence(
          crypto.randomUUID(),
          { kind: 'receiver', receiver: { ...receiver, incarnation: crypto.randomUUID() } },
          child.publish
        ),
        undefined
      );
      override = { ...table, complete: false };
      assert.equal(
        await child.owner.evidence(crypto.randomUUID(), query, child.publish),
        undefined
      );
      override = undefined;
      child.remove();
      assert.equal(
        await child.owner.evidence(crypto.randomUUID(), query, child.publish),
        undefined
      );
    } finally {
      await child.close();
    }
  }
);

it(
  'native conversation reset preserves the original receiver and receipts; a resumed entry cannot inherit them',
  {},
  async () => {
    const host = new ownership.IncomingHost('w-clear');
    const capability = await host.capability();
    assert.ok(capability);
    const child = await fixtures.child(host, 'claude', cwd);
    let resumed: Awaited<ReturnType<typeof fixtures.child>> | undefined;
    try {
      const attempt = fixtures.attempt(child.owner, { host: capability.host, generation: 1 });
      assert.equal(
        (
          await child.owner.start(
            attempt,
            () =>
              child.route.messages!.send(
                'inspect it',
                undefined,
                undefined,
                undefined,
                undefined,
                attempt.correlation
              ),
            child.publish,
            () => Promise.resolve(true)
          )
        ).ok,
        true
      );
      await fixtures.until(
        child.handle,
        (handle) => !handle.state.running && (handle.state.turnsEnded ?? 0) >= 1
      );
      const before = child.handle.state.sessionId;
      assert.ok(before);
      const receiver = child.owner.receiverIdentity;
      await child.route.messages!.send('conversation-reset-probe');
      await fixtures.until(
        child.handle,
        (handle) =>
          !!handle.state.sessionId && handle.state.sessionId !== before && !handle.state.running
      );
      const after = child.handle.state.sessionId;
      assert.ok(after);
      const proof = await child.owner.evidence(
        crypto.randomUUID(),
        { kind: 'attempt', attempt },
        child.publish
      );
      assert.deepEqual(proof?.receiver, receiver);
      assert.equal(proof?.currentSessionId, after);
      assert.equal(proof?.launch?.attempt.attemptId, attempt.attemptId);
      resumed = await fixtures.child(host, 'claude', cwd, after);
      assert.equal(resumed.handle.state.sessionId, after);
      assert.notEqual(resumed.owner.receiverIdentity.incarnation, receiver.incarnation);
      assert.equal(
        await resumed.owner.evidence(
          crypto.randomUUID(),
          { kind: 'receiver', receiver },
          resumed.publish
        ),
        undefined
      );
      assert.equal(resumed.owner.snapshot().remoteLaunchEvidence, undefined);
      assert.deepEqual(resumed.owner.snapshot().incomingDeliveries, []);
    } finally {
      await resumed?.close();
      await child.close();
    }
  }
);

it('keeps every lifetime delivery receipt past both 256 windows, in memory, in evidence and in its publication', async (context) => {
  const host = new ownership.IncomingHost('w-lifetime');
  const child = await fixtures.child(host, 'claude', cwd);
  try {
    // One real reading of this child's tree; a fresh `ps` per delivery would cost minutes.
    const table = await scan.scanProcesses(true);
    context.mock.method(scan, 'scanProcesses', () => Promise.resolve(table));
    const receiver = child.owner.receiverIdentity;
    const deliveries = Array.from({ length: 300 }, (_, index) => ({
      version: 1 as const,
      receiver,
      correlation: `delivery-${index}`,
      admissionDigest: crypto.createHash('sha256').update(String(index)).digest('hex')
    }));
    for (const delivery of deliveries)
      assert.equal(
        (
          await child.owner.deliver(
            delivery,
            'send',
            () => Promise.resolve({ ok: true }),
            () => Promise.resolve(true)
          )
        ).ok,
        true
      );
    const correlations = deliveries.map((delivery) => delivery.correlation);
    const kept = child.owner.snapshot().incomingDeliveries;
    assert.deepEqual(
      kept.map((receipt) => receipt.correlation),
      correlations
    );
    const proof = await child.owner.evidence(
      crypto.randomUUID(),
      { kind: 'delivery', delivery: deliveries[0]! },
      child.publish
    );
    assert.equal(proof?.delivery?.correlation, 'delivery-0');
    assert.equal(await child.publish(), true);
    assert.deepEqual((await published.readPublished()).get(child.pid)?.incomingDeliveries, kept);
  } finally {
    await child.close();
  }
});
