import { procStart } from './process_start';
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as platform from '../../core/platform';
import type { Page } from 'playwright-core';
import * as words from '../../core/bridge/words';
import * as boot from './boot';
import type { IncomingHolder, ReceiverIdentity } from '../../core/bridge/model';
import type { PublishedLive } from '../../core/published';
import type { Reply, RequestBody } from '../../core/coordination/requests';

/**
 * Remote across two real windows of one stock VS Code: the holder in A, the
 * sessions in B, the person's side played through the fake messenger's files.
 *
 * Run alone, never from `e2e.ts`: it opens a second window no reset knows, and
 * Remote holds `caffeinate` and restores across a reload — which is what a
 * barrel reset is. `remote_flows.test.ts` covers every scenario and brand
 * headless; this is the one place a real `serve`, real `claimRequests` polls, a
 * real holder file and two real extension hosts meet.
 *
 * Paths are spelled under `boot.homeDir()` rather than taken from
 * `core/paths`, whose constants were fixed against the real `HOME` when this
 * file was loaded.
 */

/** The one sender the allowlist names. */
const PHONE = 'phone';
/** Two credentials that must never leave `SecretStorage`. Neither has its
 *  token's prefix, so a turn-on that read them refuses on it. Spelled
 *  without the prefix itself: `slack_seam.test.ts` keeps it in `core/slack/`. */
const SENTINEL = {
  bot: `smoke-sentinel-bot-${crypto.randomUUID()}`,
  app: `smoke-sentinel-app-${crypto.randomUUID()}`,
  fake: `smoke-sentinel-fake-${crypto.randomUUID()}`
};

type Button = { label: string; payload: string };
type Notice = { kind: string; head?: string; body: string; buttons?: Button[]; settled?: string };
type Post = { kind: 'post'; notice: Notice; posted: { message: string; anchor: string } };
type Settle = { kind: 'settle'; message: string; notice: Notice };
type File = {
  kind: 'file';
  attachment: { name: string; mime: string; caption?: string; size: number };
  posted: { message: string; anchor: string };
};
type OutboxLine = Post | Settle | File;
type Holder = { windowId: string; label: string; pid: number; incoming?: IncomingHolder };

const squadron = (): string => path.join(boot.homeDir(), '.squadron');
const holderFile = (): string => path.join(squadron(), 'remote', 'holder.json');
const inboxDir = (): string => path.join(squadron(), 'remote', 'fake', 'inbox');
const outboxFile = (): string => path.join(squadron(), 'remote', 'fake', 'outbox.jsonl');
const project = (): string => path.join(boot.homeDir(), 'project');
const site = (): string => path.join(boot.homeDir(), 'site');

/** What the scenario carries from one step to the next. */
let pageB: Page;
let windowA: string;
let windowB: string;
/** The conversation the phone job opened, and the session behind it. */
let anchor: string;
let job: string;

boot.section(
  'Remote across two real windows',
  () => {
    step('a second window opens in the same instance, with a claim of its own', async () => {
      await fs.mkdir(site(), { recursive: true });
      pageB = await boot.secondWindow(site());
      const claims = await until('both windows’ claims', async () => {
        const all = await readClaims();
        const a = all.find(
          (claim) =>
            claim.folder !== undefined &&
            platform.paths.key(claim.folder) === platform.paths.key(project())
        );
        const b = all.find(
          (claim) =>
            claim.folder !== undefined &&
            platform.paths.key(claim.folder) === platform.paths.key(site())
        );
        return a && b ? { a: a.id, b: b.id } : undefined;
      });
      assert.notEqual(claims.a, claims.b);
      windowA = claims.a;
      windowB = claims.b;
      await openPanelIn(pageB);
    });

    step('A stores a credential through the input box, and turn-on reads it', async () => {
      // Slack's two fields, for its prefix check: chosen for this step alone,
      // then put back.
      await boot.patchSettings({
        'squadron.remote.messenger': 'slack',
        'squadron.remote.allowlist': ['T0123ABCD:U0123ABCD']
      });
      const page = boot.ctx.page;
      await page.keyboard.press(boot.REMOTE_KEYS.connect.chord);
      await answerInputBox(page, /Bot token/, SENTINEL.bot);
      await answerInputBox(page, /App-level token/, SENTINEL.app);
      await page.keyboard.press(boot.REMOTE_KEYS.turnOn.chord);
      // "needs the … first" would mean nothing was stored; the prefix refusal
      // means both values reached `create` from `SecretStorage`.
      await logged(/remote: not turned on — The app-level token starts /);
      await gone(holderFile(), 'a refused turn-on to release the holder');
      // The fake's own token, which every turn-on after this needs — in both
      // windows, since in-memory secret storage is each window's own.
      await boot.patchSettings({
        'squadron.remote.messenger': 'fake',
        'squadron.remote.allowlist': [PHONE]
      });
      for (const each of [page, pageB]) {
        await each.keyboard.press(boot.REMOTE_KEYS.connect.chord);
        await answerInputBox(each, /Token/, SENTINEL.fake);
      }
    });

    step('A turns Remote on; B is refused, and the holder still names A', async () => {
      await boot.ctx.page.keyboard.press(boot.REMOTE_KEYS.turnOn.chord);
      const held = await until('A to hold Remote', () => readHolder());
      assert.equal(held.windowId, windowA);
      await logged(/remote: connected/);

      await pageB.keyboard.press(boot.REMOTE_KEYS.turnOn.chord);
      await logged(/remote: not turned on — Remote is on in project\. Turn it off there first\./);
      assert.equal((await readHolder())?.windowId, windowA, 'the holder still names A');
    });

    step('2. a message offers a folder per window, and a tap starts in B', async () => {
      const prompt = 'what does the backoff here do?';
      const seen = (await posts()).length;
      await deliver({ say: { sender: PHONE, text: prompt } });
      const picker = await nextPost(seen, (post) => post.notice.kind === 'picker');
      assert.deepEqual(
        new Set(picker.notice.buttons?.map((b) => b.label)),
        new Set(['project', 'site', 'Cancel'])
      );

      const before = await boardPids(pageB);
      await deliver({ press: { sender: PHONE, payload: payloadOf(picker, 'site') } });
      await settledAs(picker, 'Choice updated');
      const models = await nextPost(
        seen,
        (post) =>
          post.notice.kind === 'picker' &&
          post.notice.buttons?.some((button) => button.label === 'Use window default') === true
      );
      await deliver({ press: { sender: PHONE, payload: payloadOf(models, 'Use window default') } });
      await settledAs(models, 'Starting');
      job = await until('a card on B’s board', async () =>
        [...(await boardPids(pageB))].find((pid) => !before.has(pid))
      );
      anchor = picker.posted.anchor;

      const done = await nextPost(
        seen,
        (post) => post.notice.kind === 'finished' && post.posted.anchor === anchor
      );
      assert.ok(done.notice.body.includes(prompt), done.notice.body);
    });

    step('1. the finish is posted, a reply drains into it, the next finish follows', async () => {
      const seen = (await posts()).length;
      await deliver({ say: { sender: PHONE, text: 'carry on please', in: anchor } });
      const next = await nextPost(
        seen,
        (post) => post.notice.kind === 'finished' && post.posted.anchor === anchor
      );
      assert.ok(next.notice.body.includes('carry on please'), next.notice.body);
      const receipts = (await posts()).slice(seen).filter((post) => post.notice.kind === 'receipt');
      assert.deepEqual(receipts, [], 'a reply to an idle session is delivered, not held');
      await cardIs(job, 'idle');
    });

    step(
      'installed fetch proves B’s native owner; both hosts share the private managed root',
      async () => {
        const published = await until('B’s exact receiver publication', async () => {
          const text = await fs
            .readFile(path.join(squadron(), 'live', `${job}.json`), 'utf8')
            .catch(() => undefined);
          const row = text ? (JSON.parse(text) as PublishedLive) : undefined;
          return row?.receiverIdentity ? row : undefined;
        });
        const receiver = published.receiverIdentity!;
        assert.equal(receiver.host.windowId, windowB);
        const a = (await requestIn({ kind: 'models', windowId: windowA })).incomingAccess;
        const b = (await requestIn({ kind: 'models', windowId: windowB })).incomingAccess;
        assert.ok(a && b);
        assert.equal(a.localRoot, b.localRoot);
        assert.equal(await fs.realpath(a.localRoot), a.localRoot);
        const stat = await fs.stat(a.localRoot);
        assert.equal(stat.uid, process.getuid?.());
        assert.equal(stat.mode & 0o077, 0);
        const challenge = crypto.randomUUID();
        const proof = await requestIn({
          kind: 'incomingEvidenceV1',
          version: 1,
          windowId: windowB,
          expectedHost: receiver.host,
          challenge,
          query: { kind: 'receiver', receiver }
        });
        assert.equal(proof.ok, true, proof.reason);
        assert.equal(proof.incomingEvidence?.challenge, challenge);
        assert.deepEqual(proof.incomingEvidence?.receiver, receiver);
        const correlation = crypto.randomUUID();
        const currentHolder = (await readHolder())?.incoming;
        assert.ok(currentHolder);
        const delivered = await requestIn({
          kind: 'send',
          windowId: windowB,
          pid: Number(job),
          startedAt: published.session.startedAt,
          text: 'inspect this original',
          correlation,
          incomingHolder: currentHolder,
          incomingDelivery: { version: 1, receiver, correlation, admissionDigest: 'a'.repeat(64) }
        });
        assert.equal(delivered.ok, true, delivered.reason);
        assert.equal(delivered.incomingDelivery?.correlation, correlation);
        assert.deepEqual(delivered.incomingDelivery?.receiver, receiver);
        await cardIs(job, 'idle');
        const wrong: ReceiverIdentity = { ...receiver, incarnation: crypto.randomUUID() };
        assert.equal(
          (
            await requestIn({
              kind: 'incomingEvidenceV1',
              version: 1,
              windowId: windowB,
              expectedHost: receiver.host,
              challenge: crypto.randomUUID(),
              query: { kind: 'receiver', receiver: wrong }
            })
          ).ok,
          false
        );
        const installed = path.join(squadron(), 'bin', 'squadron-fetch-file');
        const script = platform.launchers.scriptPath(
          path.join(squadron(), 'bin'),
          'squadron-fetch-file'
        );
        assert.deepEqual(
          await fs.readFile(script),
          await fs.readFile(
            path.join(__dirname, '..', '..', '..', 'dist', 'squadron-fetch-file.js')
          )
        );
        assert.ok((await fs.stat(installed)).mode & 0o100);
        const fetched = await nativeToolIn(
          published,
          `${shellWord(installed)} --conversation-id absent-original --message-id absent-correlation --file-id absent-file`
        );
        assert.equal(fetched.code, 2, fetched.stderr);
        assert.equal(fetched.stdout, '');
        assert.match(fetched.stderr, /the original message has no matching admitted file/);
        const local = path.join(a.localRoot, `smoke-visibility-${crypto.randomUUID()}.txt`);
        try {
          const bytes = 'same-user bytes from window A’s managed root';
          await fs.writeFile(local, bytes, { mode: 0o600, flag: 'wx' });
          const read = await nativeToolIn(published, `cat ${shellWord(local)}`);
          assert.equal(read.code, 0, read.stderr);
          assert.equal(read.stdout, bytes);
        } finally {
          await fs.rm(local, { force: true });
        }
        const before = (await readHolder())?.incoming;
        assert.ok(before);
        const identity = {
          holder: before,
          receiver,
          currentSessionId: published.session.sessionId,
          conversation: 'absent-original',
          correlation: 'absent-correlation',
          fileId: 'absent-file'
        };
        const refused = await requestIn({
          kind: 'fetchFile',
          version: 1,
          windowId: windowA,
          ...identity
        });
        assert.equal(refused.fetchFile?.kind === 'refused' && refused.fetchFile.code, 'remote-off');
        // The fake messenger has no incoming provider. No stored admission or successful byte reply is fabricated here.
        await boot.ctx.page.keyboard.press('Control+Alt+Shift+F4');
        // In-memory SecretStorage is scoped to the activation; reconnect through the real UI after reload.
        await logged(/remote: not turned on — Remote needs the Token first\./);
        await boot.ctx.page.keyboard.press(boot.REMOTE_KEYS.connect.chord);
        await answerInputBox(boot.ctx.page, /Token/, SENTINEL.fake);
        await boot.ctx.page.keyboard.press(boot.REMOTE_KEYS.turnOn.chord);
        const after = await until(
          'A’s restored holder with a new activation',
          async () => {
            const held = await readHolder();
            return held?.incoming && held.incoming.host.incarnation !== before.host.incarnation
              ? held
              : undefined;
          },
          60_000
        );
        windowA = after.windowId;
        const restored = after.incoming!;
        const holderProof = await requestIn({
          kind: 'incomingEvidenceV1',
          version: 1,
          windowId: windowA,
          expectedHost: restored.host,
          challenge: crypto.randomUUID(),
          query: { kind: 'holder', holder: restored }
        });
        assert.equal(holderProof.ok, true);
        assert.deepEqual(holderProof.incomingHolderEvidence?.holder, restored);
        assert.equal(
          (
            await requestIn({
              kind: 'incomingEvidenceV1',
              version: 1,
              windowId: windowB,
              expectedHost: receiver.host,
              challenge: crypto.randomUUID(),
              query: { kind: 'receiver', receiver }
            })
          ).ok,
          true
        );
        const stale = await requestIn({
          kind: 'fetchFile',
          version: 1,
          windowId: windowA,
          ...identity
        });
        assert.equal(stale.ok, false);
        assert.ok(!stale.fetchFile || stale.fetchFile.kind === 'refused');
        assert.deepEqual(await boardPids(pageB), new Set([job]));
      }
    );

    step('3. a permission in B is posted, and Deny reaches it as a deny', async () => {
      const seen = (await posts()).length;
      await deliver({ say: { sender: PHONE, text: 'write the notes', in: anchor } });
      const asks = await nextPost(
        seen,
        (post) => post.notice.kind === 'permission' && post.posted.anchor === anchor
      );
      assert.deepEqual(
        asks.notice.buttons?.map((b) => b.label),
        ['Deny', 'End'],
        'no Allow from a phone (D18)'
      );
      await deliver({ press: { sender: PHONE, payload: payloadOf(asks, 'Deny') } });
      await settledAs(asks, words.DENIED);
      // The fake says back the response it was handed, as the turn's last words.
      const done = await nextPost(
        seen,
        (post) => post.notice.kind === 'finished' && post.posted.anchor === anchor
      );
      assert.match(done.notice.body, /"behavior":"deny"/);
      await cardIs(job, 'idle');
    });

    step('Stop interrupts a busy turn in B, and the held reply runs after it', async () => {
      await deliver({ say: { sender: PHONE, text: 'slow down please', in: anchor } });
      await cardIs(job, 'busy');
      const seen = (await posts()).length;
      await deliver({ say: { sender: PHONE, text: 'then tidy up', in: anchor } });
      const receipt = await nextPost(
        seen,
        (post) => post.notice.kind === 'receipt' && post.posted.anchor === anchor
      );
      await deliver({ press: { sender: PHONE, payload: payloadOf(receipt, 'Stop') } });
      await settledAs(receipt, words.STOPPED);
      const done = await nextPost(
        seen,
        (post) => post.notice.kind === 'finished' && post.posted.anchor === anchor
      );
      assert.ok(done.notice.body.includes('then tidy up'), done.notice.body);
      await cardIs(job, 'idle');
    });

    /**
     * The installed `squadron-attach`, run as an agent's shell tool runs it:
     * the job's own id and pid planted, its cwd the shell's. The holder is A
     * and the session's window B, which is never asked. The fake CLI runs no
     * tools, so the command is run here; the discovery twin it does not write
     * goes the moment the shim has answered (`session.smoke.ts`, busy refusal).
     */
    step('an agent in B attaches a PNG, and it lands in its conversation through A', async () => {
      const png = path.join(site(), 'graph.png');
      await fs.writeFile(png, Buffer.from('89504e470d0a1a0a', 'hex'));
      const seen = (await outbox()).length;
      const run = await attachAs(job, [
        '--file-path',
        png,
        '--caption',
        'Latency before and after.'
      ]);
      assert.equal(run.code, 0, run.said);
      assert.equal(run.said, "sent graph.png (8 bytes) to this session's conversation\n");
      const files = (await outbox())
        .slice(seen)
        .filter((line): line is File => line.kind === 'file');
      assert.equal(files.length, 1);
      const [file] = files;
      assert.equal(file?.posted.anchor, anchor);
      assert.equal(file?.attachment.name, 'graph.png');
      assert.equal(file?.attachment.caption, 'Latency before and after.');
      assert.equal(file?.attachment.size, 8);
    });

    step(
      'with Remote off in A the shim refuses, and A refuses a holder file it outlived',
      async () => {
        const png = path.join(site(), 'graph.png');
        const held = await fs.readFile(holderFile(), 'utf8');
        await boot.ctx.page.keyboard.press(boot.REMOTE_KEYS.turnOff.chord);
        await gone(holderFile(), 'A’s turn-off to release the holder');
        const seen = (await outbox()).length;

        const off = await attachAs(job, ['--file-path', png]);
        assert.equal(off.code, 2, off.said);
        assert.match(off.said, /Remote is off, so there is no conversation to send to\./);

        // The file as a shim read it before the turn-off: A's host is still the
        // pid it names, so the request reaches A, whose own answer counts.
        await fs.writeFile(holderFile(), held);
        try {
          const late = await attachAs(job, ['--file-path', png]);
          assert.equal(late.code, 2, late.said);
          assert.ok(late.said.includes(words.OFF_HERE), late.said);
        } finally {
          await fs.rm(holderFile(), { force: true });
        }
        assert.deepEqual((await outbox()).slice(seen), [], 'nothing was posted');

        await boot.ctx.page.keyboard.press(boot.REMOTE_KEYS.turnOn.chord);
        await until('A to hold Remote again', async () =>
          (await readHolder())?.windowId === windowA ? true : undefined
        );
      }
    );

    step('End takes the session in B, after one confirm', async () => {
      const seen = (await posts()).length;
      await deliver({ command: { sender: PHONE, name: 'end', args: job } });
      const confirm = await nextPost(seen, (post) => post.notice.kind === 'confirm');
      await deliver({ press: { sender: PHONE, payload: payloadOf(confirm, 'End') } });
      await settledAs(confirm, words.ENDED);
      await until('the card to leave B’s board', async () =>
        (await boardPids(pageB)).has(job) ? undefined : true
      );
    });

    step('closing A releases the holder, and B can then turn Remote on (D37)', async () => {
      const closed = boot.ctx.page.waitForEvent('close', { timeout: 30_000 });
      await boot.ctx.page.keyboard.press(boot.REMOTE_KEYS.closeWindow.chord);
      await closed;
      await gone(holderFile(), 'A’s close to release the holder');

      await pageB.keyboard.press(boot.REMOTE_KEYS.turnOn.chord);
      const held = await until('B to hold Remote', () => readHolder());
      assert.equal(held.windowId, windowB);
      await pageB.keyboard.press(boot.REMOTE_KEYS.turnOff.chord);
      await gone(holderFile(), 'B’s turn-off to release the holder');
    });

    step('no credential is under HOME, in a child’s environment or the host logs', async () => {
      const envLog = await fs.readFile(boot.envLogPath(), 'utf8');
      assert.ok(envLog.trim().length > 0, 'no spawn logged its environment');
      const logs = path.join(boot.ctx.profile, 'data', 'logs');
      assert.ok(
        (await squadronLogs()).some((text) => text.includes('remote: connected')),
        'the host logs hold none of Remote’s lines'
      );
      for (const value of Object.values(SENTINEL)) {
        assert.deepEqual(
          filesHolding(value, [boot.homeDir(), boot.envLogPath(), logs]),
          [],
          'a credential reached the disk'
        );
      }
    });
  },
  () => ({
    'squadron.remote.messenger': 'fake',
    'squadron.remote.allowlist': [PHONE],
    // `squadron-fetch-file` and `squadron-attach` are write verbs (`cli/gate.ts`).
    'squadron.orchestrators.enabled': true
  })
);

/**
 * `boot.step`, plus window B's pixels on a red: the boot's evidence is the
 * first window's alone, and most of what this file asserts happens in B.
 */
function step(name: string, fn: () => Promise<void>): void {
  boot.step(name, async () => {
    try {
      await fn();
    } catch (error) {
      await captureB(name);
      throw error;
    }
  });
}

async function captureB(name: string): Promise<void> {
  if (!pageB || pageB.isClosed()) return;
  const root = process.env['SQUADRON_RUN'] ?? path.join(boot.homeDir(), '..');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const folder = path.join(root, 'smoke', `window-b--${slug}`);
  try {
    await fs.mkdir(folder, { recursive: true });
    await pageB.screenshot({ path: path.join(folder, 'screenshot.png'), timeout: 1500 });
    const text = await pageB
      .locator(
        '.monaco-dialog-box:visible, .notifications-toasts:visible, .quick-input-widget:visible'
      )
      .allInnerTexts();
    await fs.writeFile(path.join(folder, 'workbench.txt'), text.join('\n'));
    console.error(`  window B: ${folder}`);
  } catch {
    // Best-effort, as the boot's own capture is.
  }
}

/**
 * `~/.squadron/bin/squadron-attach` as an agent in `pid` runs it: under the
 * suite's HOME, in the session's cwd, with only what Claude plants for its
 * shell tools — this process's own identity, if it runs inside an agent, must
 * not reach the shim. A discovery twin stands for the one a real CLI writes,
 * and is removed as soon as the shim has answered.
 */
async function attachAs(pid: string, args: string[]): Promise<{ code: number; said: string }> {
  const record = JSON.parse(
    await fs.readFile(path.join(squadron(), 'live', `${pid}.json`), 'utf8')
  ) as { session: { sessionId: string } };
  const sessionId = record.session.sessionId;
  const twin = path.join(boot.homeDir(), '.claude', 'sessions', `${pid}.json`);
  await fs.mkdir(path.dirname(twin), { recursive: true });
  await fs.writeFile(
    twin,
    JSON.stringify({
      pid: Number(pid),
      sessionId,
      cwd: site(),
      procStart: await procStart(pid),
      kind: 'interactive',
      entrypoint: 'sdk-cli'
    })
  );
  try {
    const shim = platform.launchers.scriptPath(path.join(squadron(), 'bin'), 'squadron-attach');
    const run = spawnSync(process.execPath, [shim, ...args], {
      cwd: site(),
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '',
        ...boot.homeVars(),
        CLAUDE_CODE_SESSION_ID: sessionId,
        CLAUDE_PID: pid
      }
    });
    return { code: run.status ?? -1, said: `${run.stdout}${run.stderr}` };
  } finally {
    await fs.rm(twin, { force: true });
  }
}

/** One inbox event, written whole: a temp name the drain does not read, then
 *  renamed into place. */
let delivered = 0;
async function deliver(event: unknown): Promise<void> {
  const name = `${Date.now()}-${String(++delivered).padStart(3, '0')}.json`;
  const file = path.join(inboxDir(), name);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(event));
  await fs.rename(`${file}.tmp`, file);
}

async function outbox(): Promise<OutboxLine[]> {
  const text = await fs.readFile(outboxFile(), 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as OutboxLine);
}

async function posts(): Promise<Post[]> {
  return (await outbox()).filter((line): line is Post => line.kind === 'post');
}

/** The first post after the first `seen` that `match` takes. Passes are
 *  coalesced over 5 s, so a minute is several of them. */
function nextPost(seen: number, match: (post: Post) => boolean): Promise<Post> {
  return until(
    'a post',
    async () => (await posts()).slice(seen).find(match),
    60_000,
    async () =>
      (await posts())
        .slice(seen)
        .map((post) => post.notice.kind)
        .join(', ')
  );
}

async function settledAs(post: Post, word: string): Promise<void> {
  await until(`"${word}" on the ${post.notice.kind} notice`, async () =>
    (await outbox()).some(
      (line) =>
        line.kind === 'settle' &&
        line.message === post.posted.message &&
        line.notice.settled === word
    )
      ? true
      : undefined
  );
}

function payloadOf(post: Post, label: string): string {
  const found = post.notice.buttons?.find((b) => b.label === label);
  assert.ok(found, `no ${label} button on the ${post.notice.kind} notice`);
  return found.payload;
}

async function readHolder(): Promise<Holder | undefined> {
  const text = await fs.readFile(holderFile(), 'utf8').catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as Holder);
}

async function readClaims(): Promise<{ id: string; folder?: string }[]> {
  const dir = path.join(squadron(), 'windows');
  const names = await fs.readdir(dir).catch(() => []);
  const read = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        fs
          .readFile(path.join(dir, name), 'utf8')
          .then((text) => JSON.parse(text) as { id: string; folder?: string })
          .catch(() => undefined)
      )
  );
  return read.filter((claim) => claim !== undefined);
}

async function gone(file: string, why: string): Promise<void> {
  await until(why, () =>
    fs.access(file).then(
      () => undefined,
      () => true
    )
  );
}

/** Every Squadron output channel this profile's windows wrote, as text. */
async function squadronLogs(): Promise<string[]> {
  const root = path.join(boot.ctx.profile, 'data', 'logs');
  const names = (await fs.readdir(root, { recursive: true }).catch(() => [])).filter((name) =>
    name.endsWith('Squadron.log')
  );
  return Promise.all(names.map((name) => fs.readFile(path.join(root, name), 'utf8')));
}

/** A line in either window's output channel. The view's every move is logged
 *  there, which this scenario reads in place of the Remote sheet. */
async function logged(line: RegExp): Promise<void> {
  await until(`the log line ${String(line)}`, async () =>
    (await squadronLogs()).some((text) => line.test(text)) ? true : undefined
  );
}

/** Files under each root holding `value`, by `grep`, which exits 1 on none. */
function filesHolding(value: string, roots: string[]): string[] {
  try {
    return execFileSync('grep', ['-rlF', '--binary-files=text', '--', value, ...roots], {
      encoding: 'utf8'
    })
      .split('\n')
      .filter((line) => line !== '');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

async function answerInputBox(page: Page, title: RegExp, value: string): Promise<void> {
  const box = page.locator('.quick-input-widget');
  await box.locator('.quick-input-title', { hasText: title }).waitFor({ timeout: 15_000 });
  await box.locator('input').fill(value);
  await page.keyboard.press('Enter');
}

/** The panel's document in `on`, behind the host's two webview iframes. */
function panelIn(on: Page) {
  return on.frameLocator('iframe.webview.ready').last().frameLocator('iframe#active-frame');
}

async function openPanelIn(on: Page): Promise<void> {
  await on.keyboard.press('ControlOrMeta+Shift+P');
  await on.keyboard.type('Squadron: Show Sessions Overview');
  await on.keyboard.press('Enter');
  await panelIn(on).locator('#cards').waitFor({ timeout: 30_000 });
}

async function boardPids(on: Page): Promise<Set<string>> {
  const found = await panelIn(on).locator('#cards .card[data-pid]').all();
  const out = new Set<string>();
  for (const node of found) {
    const pid = await node.getAttribute('data-pid');
    if (pid) out.add(pid);
  }
  return out;
}

async function cardIs(pid: string, status: 'busy' | 'idle'): Promise<void> {
  await panelIn(pageB)
    .locator(`#cards .card[data-pid="${pid}"].${status}`)
    .waitFor({ timeout: 30_000 });
}

async function until<T>(
  why: string,
  read: () => Promise<T | undefined>,
  ms = 30_000,
  saw?: () => Promise<string>
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      assert.fail(`waited ${ms} ms for ${why}${saw ? `; saw: ${await saw()}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** Speak the existing request-file protocol under the smoke HOME, not this runner’s imported paths. */
async function requestIn(body: RequestBody): Promise<Reply> {
  const id = crypto.randomUUID();
  const prefix =
    ['incomingEvidenceV1', 'fetchFile'].includes(body.kind) ||
    ('incomingDelivery' in body && body.incomingDelivery && !('denied' in body.incomingDelivery))
      ? 'incoming-'
      : '';
  const file = path.join(squadron(), 'requests', `${prefix}${id}.request.json`);
  const reply = file.replace('.request.json', '.reply.json');
  await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...body, id, createdAt: Date.now() }));
  await fs.rename(`${file}.tmp`, file);
  try {
    return await until('the real host’s request reply', async () => {
      const text = await fs.readFile(reply, 'utf8').catch(() => undefined);
      return text ? (JSON.parse(text) as Reply) : undefined;
    });
  } finally {
    await fs.rm(file, { force: true });
    await fs.rm(reply, { force: true });
  }
}

async function nativeToolIn(
  owner: PublishedLive,
  command: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = path.join(site(), `native-tool-${crypto.randomUUID()}.json`);
  const reply = await requestIn({
    kind: 'send',
    windowId: windowB,
    pid: Number(job),
    startedAt: owner.session.startedAt,
    text: `squadron-native-tool ${JSON.stringify({ command, result })}`
  });
  assert.equal(reply.ok, true, reply.reason);
  try {
    const found = await until('B’s native shell result', async () => {
      const text = await fs.readFile(result, 'utf8').catch(() => undefined);
      return text
        ? (JSON.parse(text) as { code: number; stdout: string; stderr: string })
        : undefined;
    });
    await cardIs(job, 'idle');
    return found;
  } finally {
    await fs.rm(result, { force: true });
  }
}
