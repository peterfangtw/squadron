import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asBrand, ownPid, ownSessionId } from '../../cli/args';
import { parseArgs } from '../../cli/spawn';
import { show as showHelp } from '../../cli/help';
import { pickCause, resolveOrigin, unanswered } from '../../cli/open';
import { originWindow, pickWindow } from '../../cli/windows';
import { IDENTITY_ENV, type IdentityEnv } from '../../core/identity';
import { requestIdOf } from '../../core/coordination/requests';
import { WindowClaim } from '../../core/model';
import { PublishedLive } from '../../core/published';
import { testPlatform } from '../helpers';

function claim(id: string, folder?: string, updatedAt = 1): WindowClaim {
  return { id, label: id, app: 'VS Code', folder, shellPids: [], updatedAt };
}

/** A stand-in for `checkoutRoots`, so the choice is tested without a repository. */
function roots(pairs: Record<string, string>) {
  return (folders: Iterable<string>): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (const folder of folders) {
      const root = pairs[folder];
      if (root !== undefined) out.set(folder, root);
    }
    return Promise.resolve(out);
  };
}

describe('parseArgs', () => {
  it('reads flag/value pairs', () => {
    assert.deepEqual(parseArgs(['--cwd-path', '/repo', '--prompt', 'take ENG-412']), {
      'cwd-path': '/repo',
      prompt: 'take ENG-412'
    });
  });

  it('reads the workflow a spawn is to be put on', () => {
    assert.deepEqual(
      parseArgs(['--cwd-path', '/repo', '--prompt', 'go', '--workflow-id', 'ship']),
      {
        'cwd-path': '/repo',
        prompt: 'go',
        'workflow-id': 'ship'
      }
    );
  });

  it('reads the brand the child should start as', () => {
    assert.deepEqual(parseArgs(['--cwd-path', '/repo', '--prompt', 'go', '--brand', 'grok']), {
      'cwd-path': '/repo',
      prompt: 'go',
      brand: 'grok'
    });
  });

  it('reads the model the child should start on', () => {
    assert.deepEqual(
      parseArgs([
        '--cwd-path',
        '/repo',
        '--prompt',
        'go',
        '--brand',
        'claude',
        '--model-id',
        'opus'
      ]),
      { 'cwd-path': '/repo', prompt: 'go', brand: 'claude', 'model-id': 'opus' }
    );
  });

  it('reads the effort the child should open at', () => {
    assert.deepEqual(parseArgs(['--cwd-path', '/repo', '--prompt', 'go', '--effort', 'xhigh']), {
      'cwd-path': '/repo',
      prompt: 'go',
      effort: 'xhigh'
    });
  });

  it('keeps a prompt that looks like flags in one piece', () => {
    const opts = parseArgs(['--prompt', '--cwd-path is not a flag here']);
    assert.equal(opts?.prompt, '--cwd-path is not a flag here');
    assert.equal(opts?.['cwd-path'], undefined);
  });

  it('is malformed rather than half-read', () => {
    assert.equal(parseArgs(['--cwd-path']), undefined);
    assert.equal(parseArgs(['cwd', '/repo']), undefined);
  });

  // A bag of strings took the typo and reported "a --prompt is required", which
  // is a true sentence about the wrong thing: the caller is passing a prompt.
  it('refuses a flag it does not have, rather than filing it under the typo', () => {
    assert.equal(parseArgs(['--promt', 'take ENG-412']), undefined);
    assert.equal(parseArgs(['--cwd-path', '/repo', '--promt', 'take ENG-412']), undefined);
  });
});

describe('resolveOrigin', () => {
  it('inherits the fan-out this session was spawned into', () => {
    assert.equal(
      resolveOrigin({}, { SQUADRON_LINEAGE_ORIGIN: 'gen1', CLAUDE_CODE_SESSION_ID: 'gen3' }),
      'gen1'
    );
  });

  it('opens a fan-out at itself when it inherited none', () => {
    assert.equal(resolveOrigin({}, { CLAUDE_CODE_SESSION_ID: 'gen1' }), 'gen1');
  });

  it('opens a fan-out at a Grok session from its own id', () => {
    assert.equal(resolveOrigin({}, { GROK_AGENT: '1', GROK_SESSION_ID: 'grok-1' }), 'grok-1');
  });

  // Ordering, not preference: naming a parent explicitly opens a fan-out at
  // that parent, and without this the chip and the box would disagree.
  it('lets an explicit --parent-session-id outrank the inherited one', () => {
    assert.equal(
      resolveOrigin(
        { 'parent-session-id': 'elsewhere' },
        { SQUADRON_LINEAGE_ORIGIN: 'gen1', CLAUDE_CODE_SESSION_ID: 'gen3' }
      ),
      'elsewhere'
    );
  });

  it('has no fan-out to name outside a session', () => {
    assert.equal(resolveOrigin({}, {}), undefined);
  });

  // `--parent-session-id ""` parses, and `??` would carry the empty string down a whole
  // subtree — every generation inheriting it, and none falling past.
  it('reads an empty id as no id at all, at every rung', () => {
    assert.equal(
      resolveOrigin({ 'parent-session-id': '' }, { CLAUDE_CODE_SESSION_ID: 'gen1' }),
      'gen1'
    );
    assert.equal(
      resolveOrigin({}, { SQUADRON_LINEAGE_ORIGIN: '', CLAUDE_CODE_SESSION_ID: 'gen1' }),
      'gen1'
    );
    assert.equal(
      resolveOrigin({ 'parent-session-id': '' }, { CLAUDE_CODE_SESSION_ID: '' }),
      undefined
    );
  });
});

describe('asBrand', () => {
  it('keeps a brand the window can name', () => {
    assert.equal(asBrand('claude'), 'claude');
    assert.equal(asBrand('grok'), 'grok');
    assert.equal(asBrand('codex'), 'codex');
  });

  it('drops anything else, including empty', () => {
    assert.equal(asBrand(undefined), undefined);
    assert.equal(asBrand(''), undefined);
    assert.equal(asBrand('cursor'), undefined);
  });
});

describe('ownSessionId', () => {
  it("reads Claude's export", () => {
    assert.equal(ownSessionId({ CLAUDE_CODE_SESSION_ID: 'c1' }), 'c1');
  });

  it("reads Grok's export when that is the only one", () => {
    assert.equal(ownSessionId({ GROK_SESSION_ID: 'g1' }), 'g1');
  });

  // Observed 2026-08-16: a Grok child inside a host launched from Claude
  // carries both. The marker is what says which id is this process.
  it("prefers Grok's id when the process is a Grok agent", () => {
    assert.equal(
      ownSessionId({
        GROK_AGENT: '1',
        GROK_SESSION_ID: 'g1',
        CLAUDE_CODE_SESSION_ID: 'leaked'
      }),
      'g1'
    );
  });

  it("reads Codex's export", () => {
    assert.equal(ownSessionId({ CODEX_SESSION_ID: 'x1' }), 'x1');
  });

  it("prefers Codex's id over a leaked Claude one", () => {
    assert.equal(ownSessionId({ CODEX_SESSION_ID: 'x1', CLAUDE_CODE_SESSION_ID: 'leaked' }), 'x1');
  });

  // The unmarked pass walks IDENTITY_ENV in declaration order, and a bare
  // GROK_SESSION_ID is below Claude's in it. Pinned because that order is now a
  // property of the table rather than of a hand-written list: reordering the
  // rows for tidiness would change this answer, and nothing else would fail.
  it("prefers Claude's id over a bare Grok one, with no marker to promote it", () => {
    assert.equal(ownSessionId({ CLAUDE_CODE_SESSION_ID: 'c1', GROK_SESSION_ID: 'g1' }), 'c1');
  });

  it('reads empty as absent', () => {
    assert.equal(ownSessionId({ CLAUDE_CODE_SESSION_ID: '', GROK_SESSION_ID: '' }), undefined);
    assert.equal(ownSessionId({ GROK_AGENT: '1', GROK_SESSION_ID: '' }), undefined);
    assert.equal(ownSessionId({ CODEX_SESSION_ID: '' }), undefined);
  });
});

describe('ownPid', () => {
  it("reads Claude's export, the one brand observed to plant a pid", () => {
    assert.equal(ownPid({ CLAUDE_PID: '19102' }), 19102);
  });

  it('reads nothing for a caller of a brand whose row states no pid', () => {
    // Grok 1.0.13 and Codex 0.153.2 plant none — measured, not assumed
    // (`cli_state/grok/processes.md`, `cli_state/codex/sessions.md`). Absent is
    // the answer every caller already handles.
    assert.equal(ownPid({ GROK_AGENT: '1', GROK_SESSION_ID: 'g1' }), undefined);
    assert.equal(ownPid({ CODEX_SESSION_ID: 'x1' }), undefined);
    assert.equal(ownPid({}), undefined);
  });

  it('refuses a value that is not a pid, rather than passing NaN on', () => {
    for (const bad of ['', 'none', '0', '-1', '12.5', ' ']) {
      assert.equal(ownPid({ CLAUDE_PID: bad }), undefined, `took ${JSON.stringify(bad)}`);
    }
  });

  // Observed 2026-09-08: a Grok agent child and a Codex tool child both carried
  // a leaked `CLAUDE_PID` from the Claude session the probe ran under. This
  // pins today's answer rather than endorsing it — the ancestor's window is
  // usually the right one, and a row of this brand's own is what would beat it.
  it('still reads a leaked Claude pid for a brand that plants none', () => {
    assert.equal(ownPid({ GROK_AGENT: '1', CLAUDE_PID: '19102' }), 19102);
  });

  // The whole point of the table: the next brand to plant one is a column, not
  // an edit here. Added and removed inside the test so the shipped table stays
  // the measured one.
  it('reads a brand added to the table, with no change to this function', () => {
    const table = IDENTITY_ENV as Record<string, IdentityEnv>;
    const row: IdentityEnv = { id: 'GEMINI_SESSION_ID', marker: 'GEMINI_AGENT', pid: 'GEMINI_PID' };
    table['gemini'] = row;
    try {
      assert.equal(ownPid({ GEMINI_PID: '4242' }), 4242);
      // And the marker promotes it over a leaked Claude one, the way
      // `ownSessionId` already promotes a marked id.
      assert.equal(ownPid({ GEMINI_AGENT: '1', GEMINI_PID: '4242', CLAUDE_PID: '19102' }), 4242);
    } finally {
      delete table['gemini'];
    }
  });
});

describe('pickWindow', () => {
  it('prefers the window whose folder is the cwd', async () => {
    const claims = [claim('other', '/elsewhere'), claim('mine', '/repo')];
    const picked = await pickWindow(claims, '/repo', undefined, roots({}));
    assert.equal(picked?.id, 'mine');
  });

  it('falls back to a window on the same repository, for a worktree cwd', async () => {
    // No window's folder is the worktree path, which is the whole point: without
    // the repo match a fan-out across worktrees lands in one arbitrary window.
    const claims = [claim('unrelated', '/other-repo'), claim('same', '/repo')];
    const picked = await pickWindow(
      claims,
      '/repo/.worktrees/feature',
      undefined,
      roots({
        '/repo/.worktrees/feature': '/repo',
        '/repo': '/repo',
        '/other-repo': '/other-repo'
      })
    );
    assert.equal(picked?.id, 'same');
  });

  it('falls back to the newest claim without changing the input order', async () => {
    const claims = [claim('older', '/b', 1), claim('newest', '/a', 2)];
    const picked = await pickWindow(claims, '/nowhere', undefined, roots({}));
    assert.equal(picked?.id, 'newest');
    assert.deepEqual(
      claims.map((c) => c.id),
      ['older', 'newest']
    );
  });

  it('breaks exact-folder ties by newest claim', async () => {
    const claims = [claim('older', '/repo', 1), claim('newest', '/repo', 2)];
    const picked = await pickWindow(claims, '/repo', undefined, roots({}));
    assert.equal(picked?.id, 'newest');
  });

  it('breaks same-repository ties by newest claim', async () => {
    const claims = [claim('older', '/repo', 1), claim('newest', '/worktree', 2)];
    const picked = await pickWindow(
      claims,
      '/another-worktree',
      undefined,
      roots({ '/repo': '/repo', '/worktree': '/repo', '/another-worktree': '/repo' })
    );
    assert.equal(picked?.id, 'newest');
  });

  it('has no window to pick when none is live', async () => {
    assert.equal(await pickWindow([], '/repo', undefined, roots({})), undefined);
  });

  it('ignores a window with no folder open', async () => {
    const claims = [claim('folderless'), claim('mine', '/repo')];
    const picked = await pickWindow(claims, '/repo', undefined, roots({ '/repo': '/repo' }));
    assert.equal(picked?.id, 'mine');
  });

  // **The origin outranks every cwd tier since row 71**, and these three are
  // the reversal. A board is its own window's now, so a child that lands
  // anywhere else is one nobody can see beside its parent — placement is the
  // capability, where before it was a tidiness. The docstring on `pickWindow`
  // says the same at length, including the sentence it used to say instead.
  it('prefers the caller’s window to an exact folder match', async () => {
    const claims = [claim('caller', '/elsewhere'), claim('mine', '/repo')];
    const picked = await pickWindow(claims, '/repo', 'caller', roots({}));
    assert.equal(picked?.id, 'caller');
  });

  it('prefers the caller’s window to a window on the cwd repository', async () => {
    const claims = [claim('caller', '/other-repo'), claim('same', '/repo')];
    const picked = await pickWindow(
      claims,
      '/repo/.worktrees/feature',
      'caller',
      roots({
        '/repo/.worktrees/feature': '/repo',
        '/repo': '/repo',
        '/other-repo': '/other-repo'
      })
    );
    assert.equal(picked?.id, 'caller');
  });

  it('prefers the caller’s window to any claim at all', async () => {
    const claims = [claim('caller', '/b', 1), claim('newest', '/a', 2)];
    const picked = await pickWindow(claims, '/nowhere', 'caller', roots({}));
    assert.equal(picked?.id, 'caller');
  });

  // The cwd tiers are the fallback for a caller with no window: a hand-typed
  // terminal, or a child of a build older than `SQUADRON_ORIGIN_WINDOW`.
  // Every case above this line in the block exercises them with no origin.
  it('takes the same-repo tier when the caller has no window', async () => {
    const claims = [claim('other', '/other-repo'), claim('same', '/repo')];
    const picked = await pickWindow(
      claims,
      '/repo/.worktrees/feature',
      undefined,
      roots({
        '/repo/.worktrees/feature': '/repo',
        '/repo': '/repo',
        '/other-repo': '/other-repo'
      })
    );
    assert.equal(picked?.id, 'same');
  });

  it('ignores an origin window that is no longer live', async () => {
    // `claims` is the live list, so a dead origin is simply not in it and the
    // cwd tiers decide — rather than the spawn addressing nobody.
    const claims = [claim('newest', '/a'), claim('other', '/b')];
    const picked = await pickWindow(claims, '/nowhere', 'closed', roots({}));
    assert.equal(picked?.id, 'newest');
  });

  // VS Code records `c:\\…`; a CLI resolves `C:\\…`. Origin still ranks first.
  it('picks the window a drive letter’s case or a `/` respells, over a newer one', async (t) => {
    if (testPlatform() !== 'win32')
      return t.skip('posix: drive and separator spellings are win32 paths');
    const claims = [
      claim('vscode', 'c:\\Users\\me\\apps\\admin', 1),
      claim('newest', 'C:\\Users\\me\\elsewhere', 2)
    ];
    for (const cwd of ['C:\\Users\\me\\apps\\admin', 'C:/Users/me/apps/admin/src']) {
      assert.equal((await pickWindow(claims, cwd, undefined, roots({})))?.id, 'vscode', cwd);
    }
    assert.equal(
      (await pickWindow(claims, 'C:\\Users\\me\\apps\\admin', 'newest', roots({})))?.id,
      'newest'
    );
    assert.equal(
      (await pickWindow(claims, 'C:\\Users\\me\\apps\\admin-two', undefined, roots({})))?.id,
      'newest'
    );
  });
});

describe('originWindow', () => {
  function published(entries: Record<number, string | undefined>) {
    const map = new Map<number, PublishedLive>();
    for (const [pid, windowId] of Object.entries(entries)) {
      map.set(Number(pid), {
        session: { pid: Number(pid), ...(windowId !== undefined ? { windowId } : {}) }
      } as PublishedLive);
    }
    return map;
  }

  // **The planted variable first, for every brand** (row 71). The window that
  // starts a child writes it into that child's environment
  // (`core/session.ts`), which is the one place every brand's child is spawned
  // — so a Grok or Codex caller answers here as readily as a Claude one. The
  // record lookup below is what a child of an older build falls back to, and it
  // is Claude-only: it keys on the CLI's own pid export, and the other two
  // plant no pid at all (probed 2026-09-08).
  it('is the window that planted it, whatever brand the caller is', () => {
    // No `CLAUDE_PID` anywhere: this is exactly the Grok and Codex case, and
    // before the variable existed it was the one that fell through to cwd.
    assert.equal(originWindow({ SQUADRON_ORIGIN_WINDOW: 'w7' }, published({})), 'w7');
  });

  it('prefers the planted window to the record, which may be a stale pid', () => {
    assert.equal(
      originWindow({ SQUADRON_ORIGIN_WINDOW: 'w7', CLAUDE_PID: '42' }, published({ 42: 'w2' })),
      'w7'
    );
  });

  it('falls through a blank plant rather than reading it as a window', () => {
    assert.equal(
      originWindow({ SQUADRON_ORIGIN_WINDOW: '', CLAUDE_PID: '42' }, published({ 42: 'w2' })),
      'w2'
    );
  });

  it('is the window holding the process that ran the command', () => {
    assert.equal(originWindow({ CLAUDE_PID: '42' }, published({ 7: 'w1', 42: 'w2' })), 'w2');
  });

  it('is nothing when the environment does not say which process this is', () => {
    assert.equal(originWindow({}, published({ 42: 'w2' })), undefined);
  });

  // What `env -u CLAUDE_PID squadron-spawn` looks like, and what a Grok
  // caller looked like before the plant. With neither, `pickWindow` falls
  // through to the cwd tiers as it did before any of this existed.
  it('is nothing for a pid that reads as no number', () => {
    assert.equal(originWindow({ CLAUDE_PID: 'nonsense' }, published({ 42: 'w2' })), undefined);
    assert.equal(originWindow({ CLAUDE_PID: '' }, published({ 42: 'w2' })), undefined);
  });

  it('is nothing when no window publishes a record for the caller', () => {
    assert.equal(originWindow({ CLAUDE_PID: '42' }, published({ 7: 'w1' })), undefined);
  });

  it('is nothing for a session no window holds', () => {
    assert.equal(originWindow({ CLAUDE_PID: '42' }, published({ 42: undefined })), undefined);
  });
});

describe('unanswered', () => {
  // The whole point of the message: a caller that reads "did not answer" as
  // "did not happen" spawns a second session for one prompt. Observed on a
  // real spawn whose reply landed after the wait expired (2026-08-18).
  it('does not say the spawn failed', () => {
    const said = unanswered('agentsview', '/req/abc-123.request.json');
    assert.match(said, /may still have started/);
    assert.doesNotMatch(said, /failed|did not start|no session/i);
  });

  // The id is the only handle this side holds for a session it never heard a
  // pid for, so it has to survive into the text a model reads.
  it('names the requestId to look for', () => {
    const said = unanswered('agentsview', '/req/abc-123.request.json');
    assert.match(said, /abc-123/);
    assert.match(said, /startups/);
    assert.match(said, /lineage/);
  });

  it('names the startup file in spawn help for exit 4', () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };
    try {
      assert.equal(showHelp('spawn', 'usage: squadron-spawn\n', ['--help']), true);
    } finally {
      process.stdout.write = write;
    }
    const said = chunks.join('');
    assert.match(said, /startups\/<requestId>\.json \(written at admission\)/);
    assert.match(said, /lineage\/ \(written once the session is up\)/);
  });

  it('names the window it asked', () => {
    assert.match(unanswered('window-7', '/req/abc-123.request.json'), /window-7/);
  });
});

describe('requestIdOf', () => {
  it('is the id postRequest filed the request under', () => {
    assert.equal(requestIdOf('/some/dir/9f2c-4d1a.request.json'), '9f2c-4d1a');
  });
});

describe('pickCause', () => {
  it('keeps a pick and drops a fleet refusal and a reply that names none', () => {
    assert.deepEqual(pickCause({ cause: 'pick', startupVersion: 1, notStarted: true }), {
      cause: 'pick'
    });
    assert.equal(pickCause({ cause: 'pick' }), undefined);
    assert.equal(pickCause({ cause: 'startup', startupVersion: 1, notStarted: true }), undefined);
    assert.equal(pickCause({ cause: undefined }), undefined);
    assert.equal(pickCause(undefined), undefined);
  });
});
