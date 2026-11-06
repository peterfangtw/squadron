import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import * as attach from '../../core/remote/attach';
import { needsFileSymlinks, testPlatform } from '../helpers';

/** Every path here is real, so the realpath rule is exercised and not assumed. */
let base: string;
let tmp: string;
let outside: string;
let repo: string;
let cwd: string;

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'squadron-attach-')));
  tmp = path.join(base, 'tmp');
  outside = path.join(base, 'outside');
  repo = path.join(base, 'repo');
  cwd = path.join(repo, 'pkg');
  await fs.mkdir(tmp, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.mkdir(path.join(cwd, 'shots'), { recursive: true });
  await fs.mkdir(path.join(cwd, '.secrets'), { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  await fs.writeFile(path.join(cwd, 'plot.png'), 'png');
  await fs.writeFile(path.join(cwd, 'shots', 'one.png'), 'png');
  await fs.writeFile(path.join(repo, 'README.md'), 'readme');
  await fs.writeFile(path.join(tmp, 'screen.png'), 'png');
  await fs.writeFile(path.join(cwd, 'ordinary.txt'), 'ordinary');
  await fs.writeFile(path.join(cwd, '.secrets', 'x'), 'hidden');
  if (!needsFileSymlinks()) {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(cwd, 'escape.txt'));
    await fs.symlink(path.join(cwd, 'ordinary.txt'), path.join(cwd, '.env'));
    await fs.symlink(path.join(cwd, '.secrets', 'x'), path.join(cwd, 'innocent.txt'));
  }
});

/** The holder's whole check, as `serveAttach` and the shim run it. */
async function verdict(
  raw: string,
  at: string = cwd,
  deny: readonly string[] = []
): Promise<{ ok: true; root: string } | { ok: false; reason: string }> {
  const file = await attach.inspectFile(raw, at);
  if (!file.ok) return file;
  return attach.checkPath(file, await attach.attachRoots(at, { tmp: [tmp] }), deny);
}

function refused(result: { ok: boolean; reason?: string }): string {
  assert.equal(result.ok, false, 'expected a refusal');
  return result.reason ?? '';
}

describe('attachRoots', () => {
  it('keeps scratch outputs denied and permits a copy into the temp directory', async () => {
    const state = path.join(base, '.squadron');
    const scratch = path.join(state, 'scratch', 'session');
    await fs.mkdir(scratch, { recursive: true });
    const output = path.join(scratch, 'result.txt');
    await fs.writeFile(output, 'result');
    assert.match(refused(await verdict(output, scratch, [state])), /never sent.*temp directory/);
    const copy = path.join(tmp, 'result.txt');
    await fs.copyFile(output, copy);
    assert.equal((await verdict(copy, scratch, [state])).ok, true);
  });
  it('is the cwd, its working tree and the temp directories, realpathed', async () => {
    const roots = await attach.attachRoots(cwd, { tmp: [tmp] });
    assert.deepEqual([...roots].sort(), [cwd, repo, tmp].sort());
  });

  it('drops a root that does not exist rather than throwing', async () => {
    const roots = await attach.attachRoots(cwd, { tmp: [path.join(base, 'gone')] });
    assert.deepEqual([...roots].sort(), [cwd, repo].sort());
  });

  it('drops the filesystem root, under which ~/Library has a second name', async () => {
    const roots = await attach.attachRoots('/', { tmp: [tmp] });
    assert.deepEqual(roots, [tmp]);
  });

  it('defaults the temp directories to the os one and /tmp', async () => {
    const roots = await attach.attachRoots(cwd);
    assert.ok(roots.includes(await fs.realpath(os.tmpdir())));
    assert.ok(roots.includes(await fs.realpath('/tmp')));
  });
});

describe('which files may go', () => {
  it('admits a file in the cwd, under it, in the tree above it, and in temp', async () => {
    assert.equal((await verdict('plot.png')).ok, true);
    assert.equal((await verdict(path.join('shots', 'one.png'))).ok, true);
    assert.equal((await verdict(path.join(repo, 'README.md'))).ok, true);
    assert.equal((await verdict(path.join(tmp, 'screen.png'))).ok, true);
  });

  it('names the deepest root a file falls in', async () => {
    const found = await verdict('plot.png');
    assert.ok(found.ok);
    assert.equal(found.root, cwd);
  });

  it(
    'refuses a symlink in the cwd that points outside every root, on its realpath',
    { skip: needsFileSymlinks() },
    async () => {
      assert.match(refused(await verdict('escape.txt')), /outside/);
    }
  );

  it(
    'refuses a symlink named .env on the name it was given',
    { skip: needsFileSymlinks() },
    async () => {
      assert.match(refused(await verdict('.env')), /hidden.*\.env/);
    }
  );

  it(
    'refuses an ordinary name pointing into a hidden directory, on its realpath',
    { skip: needsFileSymlinks() },
    async () => {
      assert.match(refused(await verdict('innocent.txt')), /hidden.*\.secrets/);
    }
  );

  it('refuses a key under a session started in HOME', async () => {
    const home = path.join(base, 'home');
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(home, '.ssh', 'id_rsa'), 'key');
    assert.match(refused(await verdict(path.join('.ssh', 'id_rsa'), home)), /hidden.*\.ssh/);
  });

  it('reads the hidden rule relative to the root, so a cwd under a dot directory works', async () => {
    const under = path.join(base, '.worktrees', 'wt');
    await fs.mkdir(under, { recursive: true });
    await fs.writeFile(path.join(under, 'shot.png'), 'png');
    assert.equal((await verdict('shot.png', under)).ok, true);
  });

  it('refuses a file under a denied directory even when a root holds it', async () => {
    const data = path.join(cwd, 'userdata');
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, 'state.vscdb'), 'secrets');
    assert.match(refused(await verdict(path.join(data, 'state.vscdb'), cwd, [data])), /never sent/);
  });

  it('does not admit the main checkout from a linked worktree', async () => {
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    const admin = path.join(main, '.git', 'worktrees', 'wt');
    await fs.mkdir(admin, { recursive: true });
    await fs.writeFile(path.join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/wt\n');
    await fs.writeFile(path.join(admin, 'commondir'), '../..\n');
    await fs.mkdir(wt, { recursive: true });
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${admin}\n`);
    await fs.writeFile(path.join(main, 'file.txt'), 'main');
    await fs.writeFile(path.join(wt, 'file.txt'), 'wt');
    assert.match(refused(await verdict(path.join(main, 'file.txt'), wt)), /outside/);
    assert.equal((await verdict('file.txt', wt)).ok, true);
  });
});

describe('attachDeny', () => {
  it('denies ~/Library to a session whose root holds it, and to none that does not', async () => {
    const home = path.join(base, 'home');
    const library = path.join(home, 'Library');
    const kept = path.join(library, 'Keychains', 'login.keychain-db');
    await fs.mkdir(path.dirname(kept), { recursive: true });
    await fs.writeFile(kept, 'keychain');
    await fs.writeFile(path.join(home, 'notes.md'), 'notes');

    const atHome = await attach.attachRoots(home, { tmp: [tmp] });
    const deny = await attach.attachDeny(atHome, [outside], home);
    assert.deepEqual(deny, [outside, library]);
    const file = await attach.inspectFile(kept, home);
    assert.ok(file.ok);
    assert.match(refused(attach.checkPath(file, atHome, deny)), /never sent/);
    const notes = await attach.inspectFile('notes.md', home);
    assert.ok(notes.ok);
    assert.equal(attach.checkPath(notes, atHome, deny).ok, true);

    assert.deepEqual(
      await attach.attachDeny(await attach.attachRoots(cwd, { tmp: [tmp] }), [outside], home),
      [outside]
    );
    const inside = await attach.attachRoots(path.dirname(kept), { tmp: [tmp] });
    assert.deepEqual(await attach.attachDeny(inside, [], home), []);
  });
});

describe('inspectFile', () => {
  it(
    'gives the path as given, its realpath and its size',
    { skip: needsFileSymlinks() },
    async () => {
      const file = await attach.inspectFile('innocent.txt', cwd);
      assert.ok(file.ok);
      assert.equal(file.given, path.join(cwd, 'innocent.txt'));
      assert.equal(file.real, path.join(cwd, '.secrets', 'x'));
      assert.equal(file.size, 'hidden'.length);
    }
  );

  it('refuses a missing file', async () => {
    assert.match(refused(await attach.inspectFile('nope.png', cwd)), /no such file/i);
  });

  it('refuses a directory', async () => {
    assert.match(refused(await attach.inspectFile('shots', cwd)), /directory/);
  });

  it('refuses a FIFO', { skip: testPlatform() === 'win32' && 'win32: no FIFOs' }, async () => {
    const fifo = path.join(cwd, 'pipe');
    execFileSync('mkfifo', [fifo]);
    assert.match(refused(await attach.inspectFile('pipe', cwd)), /not a regular file/);
  });

  it('refuses an empty file', async () => {
    await fs.writeFile(path.join(cwd, 'empty.txt'), '');
    assert.match(refused(await attach.inspectFile('empty.txt', cwd)), /empty/);
  });

  it('refuses a file one byte over the cap, and admits one at it', async () => {
    const at = path.join(cwd, 'at.bin');
    const over = path.join(cwd, 'over.bin');
    await fs.writeFile(at, '');
    await fs.truncate(at, attach.ATTACH_MAX_BYTES);
    await fs.writeFile(over, '');
    await fs.truncate(over, attach.ATTACH_MAX_BYTES + 1);
    assert.equal((await attach.inspectFile('at.bin', cwd)).ok, true);
    assert.match(refused(await attach.inspectFile('over.bin', cwd)), /10 MiB/);
  });

  it("says the messenger's limit when that is the smaller", async () => {
    assert.match(refused(await attach.inspectFile('plot.png', cwd, 2)), /messenger's limit/);
  });
});

describe('checkCaption', () => {
  it('trims, and reads empty as absent', () => {
    assert.deepEqual(attach.checkCaption('  the plot \n'), { ok: true, caption: 'the plot' });
    assert.deepEqual(attach.checkCaption('   '), { ok: true });
    assert.deepEqual(attach.checkCaption(undefined), { ok: true });
  });

  it('keeps newlines and tabs', () => {
    assert.deepEqual(attach.checkCaption('a\n\tb'), { ok: true, caption: 'a\n\tb' });
  });

  it('refuses one over the limit, and takes one at it', () => {
    assert.equal(attach.checkCaption('x'.repeat(attach.CAPTION_MAX)).ok, true);
    assert.match(refused(attach.checkCaption('x'.repeat(attach.CAPTION_MAX + 1))), /1000/);
  });

  it('refuses control characters', () => {
    assert.match(refused(attach.checkCaption('a\u0007b')), /control/);
    assert.match(refused(attach.checkCaption('a\u001b[31mb')), /control/);
  });
});

describe('mimeOf', () => {
  it('reads the extension case-insensitively', () => {
    assert.equal(attach.mimeOf('Plot.PNG'), 'image/png');
    assert.equal(attach.mimeOf('report.html'), 'text/html');
    assert.equal(attach.mimeOf('change.diff'), 'text/x-diff');
    assert.equal(attach.mimeOf('a.json'), 'application/json');
  });

  it('is octet-stream for anything else, and for no extension', () => {
    assert.equal(attach.mimeOf('core.bin'), 'application/octet-stream');
    assert.equal(attach.mimeOf('Makefile'), 'application/octet-stream');
  });
});

describe('AttachGuard', () => {
  /** Admitted, and the post landed at `at`. */
  function post(guard: InstanceType<typeof attach.AttachGuard>, key: string, at: number) {
    const admitted = guard.admit(key, at);
    assert.ok(admitted.ok);
    guard.posted(admitted.slot, at);
  }

  it('refuses the eleventh from one session within a minute', () => {
    const guard = new attach.AttachGuard();
    for (let i = 0; i < 10; i++) post(guard, 'a', i * 1000);
    assert.match(refused(guard.admit('a', 10_000)), /10 a minute/);
    assert.equal(guard.admit('b', 10_000).ok, true, 'another session has its own budget');
    assert.equal(guard.admit('a', 60_001).ok, true, 'the minute moves on');
  });

  it('has no machine cap: every session keeps its own ten a minute', () => {
    const guard = new attach.AttachGuard();
    for (let minute = 0; minute < 15; minute++) {
      for (let s = 0; s < 3; s++) {
        for (let i = 0; i < 10; i++) post(guard, `s${s}`, minute * 60_000 + s * 100 + i);
      }
    }
    assert.equal(guard.admit('fresh', 15 * 60_000 - 1).ok, true);
  });

  it('holds a slot from admission, so attachments still in flight count', () => {
    const guard = new attach.AttachGuard();
    for (let i = 0; i < 10; i++) assert.equal(guard.admit('a', i).ok, true);
    assert.match(refused(guard.admit('a', 10)), /10 a minute/);
  });

  it('frees a released slot, so an attempt that went nowhere costs nothing', () => {
    const guard = new attach.AttachGuard();
    for (let i = 0; i < 9; i++) post(guard, 'a', i);
    for (let i = 0; i < 10; i++) {
      const admitted = guard.admit('a', 10 + i);
      assert.ok(admitted.ok);
      guard.release(admitted.slot);
    }
    post(guard, 'a', 30);
    assert.equal(guard.admit('a', 31).ok, false);
  });

  it('dates a slot by its post, not its admission', () => {
    const guard = new attach.AttachGuard();
    const admitted = guard.admit('a', 0);
    assert.ok(admitted.ok);
    guard.posted(admitted.slot, 50_000);
    for (let i = 0; i < 9; i++) post(guard, 'a', 55_000 + i);
    assert.equal(guard.admit('a', 60_010).ok, false, 'the slow one landed 10 s ago');
  });

  it('counts an upload that took longer than the minute', () => {
    const guard = new attach.AttachGuard();
    const slow = guard.admit('a', 0);
    assert.ok(slow.ok);
    for (let i = 0; i < 9; i++) post(guard, 'a', 70_000 + i);
    guard.posted(slow.slot, 70_100);
    assert.equal(guard.admit('a', 70_200).ok, false, 'the slow one landed 100 ms ago');
  });
});
