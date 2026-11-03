import { incomingPlatformFixture } from './incoming_platform_helpers';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { tempHome, linkDir, needsFileSymlinks, testPlatform } from '../helpers';
import type { Attached, Attachment, SessionAddr } from '../../core/bridge/model';
import type { Session } from '../../core/model';
import type { Target } from '../../core/remote/board';
import type { AttachRequest } from '../../core/remote/serve_attach';

type Serve = typeof import('../../core/remote/serve_attach');
type Rules = typeof import('../../core/remote/attach');
type Words = typeof import('../../core/bridge/words');

let serve: Serve;
let rules: Rules;
let words: Words;
let home: string;
let cwd: string;

let disposePrivateFiles: (() => Promise<void>) | undefined;
after(async () => {
  await disposePrivateFiles?.();
});
before(async () => {
  const spelled = await tempHome();
  disposePrivateFiles = await incomingPlatformFixture(spelled);
  home = await fs.realpath(spelled);
  serve = await import('../../core/remote/serve_attach');
  rules = await import('../../core/remote/attach');
  words = await import('../../core/bridge/words');
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-serve-attach-')));
  await fs.writeFile(path.join(cwd, 'plot.png'), 'png bytes');
});

const SESSION_WINDOW = 'w-session';
const HOLDER_WINDOW = 'w-holder';

const session = (): Session => ({
  pid: 4242,
  sessionId: 'sid-4242',
  cwd,
  name: 'plotter',
  status: 'busy',
  hasCommand: false,
  startedAt: 1000,
  updatedAt: 0,
  transcript: '',
  source: 'owned',
  windowId: SESSION_WINDOW
});

const request = (over: Partial<AttachRequest> = {}): AttachRequest => ({
  kind: 'attach',
  windowId: HOLDER_WINDOW,
  pid: 4242,
  startedAt: 1000,
  sessionWindowId: SESSION_WINDOW,
  path: path.join(cwd, 'plot.png'),
  caption: 'the plot',
  from: 'sid-4242',
  id: 'req-1',
  createdAt: Date.now(),
  ...over
});

type Sent = { addr: SessionAddr; attachment: Attachment; bytes: string };

/** A port over nothing: every call recorded, every answer stated. */
function port(
  over: Partial<{
    holds: boolean;
    target: Target;
    attach: (attachment: Attachment) => Promise<Attached>;
    guard: InstanceType<Rules['AttachGuard']>;
  }> = {}
) {
  const sent: Sent[] = [];
  const targeted: SessionAddr[] = [];
  const value = {
    holds: () => over.holds ?? true,
    guard: over.guard ?? new rules.AttachGuard(),
    deny: [path.join(home, '.squadron')],
    target: (addr: SessionAddr): Promise<Target> => {
      targeted.push(addr);
      const found = { ...session(), pid: addr.pid, sessionId: `sid-${addr.pid}` };
      return Promise.resolve(over.target ?? { ok: true, session: found, maxBytes: 1_000_000_000 });
    },
    attach: async (addr: SessionAddr, attachment: Attachment) => {
      sent.push({ addr, attachment, bytes: Buffer.from(attachment.bytes).toString('utf8') });
      return over.attach ? over.attach(attachment) : { ok: true as const };
    }
  };
  return { port: value, sent, targeted };
}

describe('serveAttach', () => {
  it('refuses a file changed after binding without posting or spending its slot', async (t) => {
    const platform = await import('../../core/platform');
    const open = platform.privateFiles.open;
    const file = path.join(cwd, 'changes-during-read.txt');
    await fs.writeFile(file, 'before');
    t.mock.method(platform.privateFiles, 'open', async (...args: Parameters<typeof open>) => {
      const result = await open(...args);
      if (!result.supported || result.status !== 'ok') return result;
      const bound = result.value.bound.bind(result.value);
      result.value.bound = async (at) => {
        const answer = await bound(at);
        await fs.appendFile(file, 'after');
        return answer;
      };
      return result;
    });
    const { port: p, sent } = port();
    const reply = await serve.serveAttach(request({ path: file }), p);
    assert.deepEqual(reply, {
      ok: false,
      reason: `${file} changed while it was being read; send it again`
    });
    assert.equal(sent.length, 0);
    t.mock.restoreAll();
    assert.deepEqual(await serve.serveAttach(request({ path: file }), p), { ok: true });
  });
  it('posts the bytes it checked, named as given, to the session it names', {}, async () => {
    const { port: p, sent, targeted } = port();
    const reply = await serve.serveAttach(request(), p);
    assert.deepEqual(reply, { ok: true });
    assert.equal(sent.length, 1);
    const [one] = sent;
    assert.ok(one);
    const addr = { pid: 4242, startedAt: 1000, windowId: SESSION_WINDOW };
    assert.deepEqual(one.addr, addr);
    assert.deepEqual(targeted, [addr]);
    assert.equal(one.bytes, 'png bytes');
    assert.equal(one.attachment.name, 'plot.png');
    assert.equal(one.attachment.mime, 'image/png');
    assert.equal(one.attachment.caption, 'the plot');
    assert.equal('path' in one.attachment, false, 'no path travels past the check');
  });

  it('sends the bytes it checked, whatever lands at the path before the post', {}, async () => {
    const file = path.join(cwd, 'swapped.txt');
    await fs.writeFile(file, 'checked bytes');
    let seen = '';
    const { port: p } = port({
      attach: async (attachment) => {
        await fs.rm(file);
        await linkDir(path.join(home, '.squadron'), file);
        seen = Buffer.from(attachment.bytes).toString('utf8');
        return { ok: true };
      }
    });
    assert.deepEqual(await serve.serveAttach(request({ path: file }), p), { ok: true });
    assert.equal(seen, 'checked bytes');
  });

  it("keeps a symlink's own name", { skip: needsFileSymlinks() }, async () => {
    await fs.symlink(path.join(cwd, 'plot.png'), path.join(cwd, 'alias.png'));
    const { port: p, sent } = port();
    assert.deepEqual(await serve.serveAttach(request({ path: path.join(cwd, 'alias.png') }), p), {
      ok: true
    });
    assert.equal(sent[0]?.attachment.name, 'alias.png');
  });

  it('refuses in a window that does not hold Remote, before anything else', async () => {
    const { port: p, sent, targeted } = port({ holds: false });
    assert.deepEqual(await serve.serveAttach(request(), p), {
      ok: false,
      reason: words.OFF_HERE
    });
    assert.equal(targeted.length, 0);
    assert.equal(sent.length, 0);
  });

  it('refuses where the OS has no owner check, before opening or posting anything', async (t) => {
    const platform = await import('../../core/platform');
    const win32 = await import('../../core/platform/private_files/win32');
    t.mock.method(platform.privateFiles, 'open', win32.privateFiles().open);
    const opens = t.mock.method(fs, 'open');
    const { port: p, sent } = port();
    assert.deepEqual(await serve.serveAttach(request(), p), {
      ok: false,
      reason: 'privateFiles.open is unavailable on win32: no owner or file-identity check — W6.6'
    });
    assert.equal(sent.length, 0);
    assert.equal(opens.mock.callCount(), 0);
  });

  it('refuses a raw request whose path escapes the roots, without the shim', async () => {
    const { port: p, sent } = port();
    const file = path.join(home, 'outside-attachment.txt');
    await fs.writeFile(file, 'outside');
    const outside = await fs.realpath(file);
    const roots = await rules.attachRoots(cwd);
    assert.ok(
      roots.every((root) => {
        const relative = path.relative(root, outside);
        return (
          relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
        );
      }),
      'fixture file is outside every attachment root'
    );
    const reply = await serve.serveAttach(request({ path: outside }), p);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /outside/);
    assert.equal(sent.length, 0);
  });

  it('refuses a raw request naming the state directory', async () => {
    const state = path.join(home, '.squadron', 'remote');
    await fs.mkdir(state, { recursive: true });
    await fs.writeFile(path.join(state, 'holder.json'), '{}');
    const { port: p, sent } = port({
      target: { ok: true, session: { ...session(), cwd: home }, maxBytes: 1_000_000_000 }
    });
    const reply = await serve.serveAttach(request({ path: path.join(state, 'holder.json') }), p);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /never sent/);
    assert.equal(sent.length, 0);
  });

  it("refuses a file over the messenger's limit but under ours, staging nothing", async () => {
    const { port: p, sent } = port({ target: { ok: true, session: session(), maxBytes: 4 } });
    const reply = await serve.serveAttach(request(), p);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /messenger's limit/);
    assert.equal(sent.length, 0);
  });

  it("passes the bridge's own refusal through, as for a messenger with no files", async () => {
    const { port: p, sent } = port({ target: { ok: false, reason: words.NO_FILES } });
    assert.deepEqual(await serve.serveAttach(request(), p), {
      ok: false,
      reason: words.NO_FILES
    });
    assert.equal(sent.length, 0);
  });

  it('refuses a caption the shim would have refused', async () => {
    const { port: p, sent } = port();
    const reply = await serve.serveAttach(request({ caption: 'a\u0007b' }), p);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /control/);
    assert.equal(sent.length, 0);
  });

  it('counts neither a refusal nor a throw', {}, async () => {
    const guard = new rules.AttachGuard();
    const refusing = port({
      guard,
      attach: () => Promise.resolve({ ok: false, reason: 'the messenger said no' })
    });
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await serve.serveAttach(request(), refusing.port), {
        ok: false,
        reason: 'the messenger said no'
      });
    }
    const throwing = port({ guard, attach: () => Promise.reject(new Error('socket closed')) });
    const reply = await serve.serveAttach(request(), throwing.port);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /socket closed/);
    assert.equal(guard.admit('4242:1000', Date.now()).ok, true, 'nothing was posted');
  });

  it('refuses the eleventh success from one session in a minute', {}, async () => {
    const { port: p, sent } = port();
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await serve.serveAttach(request(), p), { ok: true });
    }
    const reply = await serve.serveAttach(request(), p);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /10 a minute/);
    assert.equal(sent.length, 10);
  });
});

describe('serveAttach: an outcome nobody knows', () => {
  const lost = () =>
    Promise.resolve({
      ok: false,
      reason: 'files.completeUploadExternal: unreadable_reply',
      unsure: true
    } as const);

  it('answers unsure, not refused, when the post may have landed', {}, async () => {
    const { port: p } = port({ attach: lost });
    assert.deepEqual(await serve.serveAttach(request(), p), {
      ok: false,
      reason: 'files.completeUploadExternal: unreadable_reply',
      unsure: true
    });
  });

  it('counts a post that may have landed against the cap', {}, async () => {
    const guard = new rules.AttachGuard();
    const unsure = port({ guard, attach: lost });
    for (let i = 0; i < 10; i++) await serve.serveAttach(request(), unsure.port);
    const { port: p, sent } = port({ guard });
    const reply = await serve.serveAttach(request(), p);
    assert.match(reply.reason ?? '', /a minute/);
    assert.equal(sent.length, 0);
  });
});

describe('serveAttach: who is sending', () => {
  it('caps the session the request names, so a forged sender cannot reset it', {}, async () => {
    const { port: p, sent } = port();
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await serve.serveAttach(request(), p), { ok: true });
    }
    const reply = await serve.serveAttach(request({ from: 'sid-forged' }), p);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /a minute/);
    assert.equal(sent.length, 10);
  });

  it('refuses a sender that is not the session the request names', async () => {
    const guard = new rules.AttachGuard();
    const { port: p, sent } = port({ guard });
    const reply = await serve.serveAttach(request({ from: 'sid-other' }), p);
    assert.equal(reply.ok, false);
    assert.match(reply.reason ?? '', /sid-other/);
    assert.equal(sent.length, 0);
    for (let i = 0; i < 10; i++) assert.equal(guard.admit('4242:1000', i).ok, true, 'no slot kept');
  });
});

describe('serveAttach: a burst', () => {
  it('admits exactly ten of 21 sent at once by one session', {}, async () => {
    const { port: p, sent } = port();
    const replies = await Promise.all(
      Array.from({ length: 21 }, () => serve.serveAttach(request(), p))
    );
    assert.equal(replies.filter((reply) => reply.ok).length, 10, JSON.stringify(replies));
    assert.equal(sent.length, 10);
    for (const reply of replies.filter((r) => !r.ok)) assert.match(reply.reason ?? '', /a minute/);
  });

  it('admits all 21 sent at once by 21 sessions: there is no machine cap', {}, async () => {
    const { port: p, sent } = port();
    const replies = await Promise.all(
      Array.from({ length: 21 }, (_, i) =>
        serve.serveAttach(request({ pid: 5000 + i, from: `sid-${5000 + i}` }), p)
      )
    );
    assert.equal(replies.filter((reply) => reply.ok).length, 21, JSON.stringify(replies));
    assert.equal(sent.length, 21);
  });

  it('frees the slot of an attachment that was refused', {}, async () => {
    const guard = new rules.AttachGuard();
    const refusing = port({
      guard,
      attach: () => Promise.resolve({ ok: false, reason: 'the messenger said no' })
    });
    await Promise.all(
      Array.from({ length: 10 }, () => serve.serveAttach(request(), refusing.port))
    );
    const { port: p } = port({ guard });
    assert.deepEqual(await serve.serveAttach(request(), p), { ok: true });
  });
});

describe('readChecked', () => {
  /** The roots and deny list `serveAttach` hands it for a session in `cwd`. */
  const area = async () => ({
    roots: await rules.attachRoots(cwd),
    deny: await rules.realDirs([path.join(home, '.squadron')])
  });

  /** `file` as `serveAttach` finds it before staging. */
  async function inspect(file: string, cap = rules.ATTACH_MAX_BYTES) {
    const inspected = await rules.inspectFile(file, cwd, cap);
    assert.ok(inspected.ok);
    return inspected;
  }

  it('answers the bytes it read, and writes no copy', {}, async () => {
    const file = path.join(cwd, 'stage.txt');
    await fs.writeFile(file, 'twelve bytes');
    const result = await serve.readChecked(await inspect(file), await area(), 12);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(Buffer.from(result.bytes).toString('utf8'), 'twelve bytes');
    assert.equal('path' in result, false);
  });

  it("holds the file's size in memory through the post, not the cap's", {}, async () => {
    const file = path.join(cwd, 'small.txt');
    await fs.writeFile(file, 'twelve bytes');
    const inspected = await inspect(file);
    const result = await serve.readChecked(inspected, await area(), rules.ATTACH_MAX_BYTES);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.bytes.toString(), 'twelve bytes');
    assert.ok(result.bytes.buffer.byteLength <= 13, String(result.bytes.buffer.byteLength));
  });

  it('refuses a file that grew past the cap after it was inspected', async () => {
    const file = path.join(cwd, 'grows.log');
    await fs.writeFile(file, '0123456789');
    const inspected = await inspect(file, 10);
    await fs.appendFile(file, 'more');
    const result = await serve.readChecked(inspected, await area(), 10);
    assert.equal(result.ok, false);
  });

  it(
    'refuses a FIFO swapped in after the check without waiting on a writer',
    { timeout: 5_000, skip: testPlatform() === 'win32' && 'win32: no FIFOs' },
    async () => {
      const file = path.join(cwd, 'plot.fifo');
      await fs.writeFile(file, 'png');
      const inspected = await inspect(file);
      await fs.rm(file);
      execFileSync('mkfifo', [file]);
      const result = await serve.readChecked(inspected, await area(), rules.ATTACH_MAX_BYTES);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /not a regular file/);
    }
  );

  it(
    "refuses another user's file, as in a shared temp directory",
    {
      skip:
        testPlatform() === 'win32' &&
        'win32: POSIX uid override; native SID refusal is covered by private_files_facility'
    },
    async (t) => {
      const file = path.join(cwd, 'theirs.txt');
      await fs.writeFile(file, 'theirs');
      const inspected = await inspect(file);
      const uid = process.getuid?.() ?? 0;
      t.mock.method(process as { getuid(): number }, 'getuid', () => uid + 1);
      const result = await serve.readChecked(inspected, await area(), rules.ATTACH_MAX_BYTES);
      assert.equal(result.ok, false);
      assert.match(result.ok ? '' : result.reason, /another user/);
    }
  );

  it(
    'refuses a symlink swapped in at the realpath after the check',
    { skip: needsFileSymlinks() },
    async () => {
      const file = path.join(cwd, 'swap.png');
      await fs.writeFile(file, 'png');
      const inspected = await inspect(file);
      await fs.rm(file);
      await fs.symlink(process.execPath, file);
      const result = await serve.readChecked(inspected, await area(), rules.ATTACH_MAX_BYTES);
      assert.equal(result.ok, false);
    }
  );

  /**
   * `<cwd>/<name>/id_rsa`, harmless when inspected, and `secret`, a directory
   * holding a private `id_rsa` the parent can be swapped for.
   */
  async function swappable(name: string, secret: string) {
    const visible = path.join(cwd, name);
    await fs.mkdir(visible);
    await fs.writeFile(path.join(visible, 'id_rsa'), 'harmless');
    await fs.mkdir(secret, { recursive: true });
    await fs.writeFile(path.join(secret, 'id_rsa'), 'PRIVATE KEY');
    const inspected = await inspect(path.join(visible, 'id_rsa'));
    const toSecret = async () => {
      await fs.rename(visible, `${visible}.was`);
      await linkDir(secret, visible);
    };
    const back = async () => {
      await fs.rm(visible, { recursive: true });
      await fs.rename(`${visible}.was`, visible);
    };
    return { inspected, toSecret, back };
  }

  it('refuses a parent directory swapped for a link to a hidden one', {}, async () => {
    const swap = await swappable('export', path.join(cwd, '.ssh'));
    await swap.toSecret();
    const result = await serve.readChecked(swap.inspected, await area(), rules.ATTACH_MAX_BYTES);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /hidden|not a regular file/);
  });

  it('refuses a parent directory swapped for a link into the state directory', {}, async () => {
    const swap = await swappable('state-export', path.join(home, '.squadron', 'remote'));
    await swap.toSecret();
    const result = await serve.readChecked(swap.inspected, await area(), rules.ATTACH_MAX_BYTES);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /never sent|not a regular file/);
  });

  it('refuses a descriptor opened through a swap undone before the recheck', {}, async (t) => {
    const swap = await swappable('flicker', path.join(cwd, '.keys'));
    await swap.toSecret();
    const platform = await import('../../core/platform');
    const open = platform.privateFiles.open;
    t.mock.method(
      platform.privateFiles,
      'open',
      async (file: string, purpose: 'attachment') => {
        const handle = await open(await fs.realpath(file), purpose);
        await swap.back();
        return handle;
      },
      { times: 1 }
    );
    const result = await serve.readChecked(swap.inspected, await area(), rules.ATTACH_MAX_BYTES);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /changed/);
  });
});
