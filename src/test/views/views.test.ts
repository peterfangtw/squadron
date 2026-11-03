import { ticketPriority, ticketState } from '../ticket_fixtures';
import * as cacheTtl from '../../core/cache_ttl';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { BrandId } from '../../core/model';
import type { Model } from '../../core/model_names';
import { Ticket, toTicketView } from '../../core/tickets';
import { DEFAULT_WARM_POLICY, type WarmPolicy } from '../../core/warm_policy';
import { modeView, modelViews, toCard, warmView } from '../../ui/views';
import { session } from '../views_helpers';

describe('toCard', () => {
  it('carries the active ping cue and clears it when closing, independent of the warm preference', () => {
    for (const warm of [false, true]) {
      for (const warming of [undefined, true] as const) {
        const view = toCard(session({ warm, warming }));
        assert.equal(view.warming, warming);
        assert.equal(toCard(session({ warm, warming, closing: true })).warming, undefined);
      }
    }
  });
  it('projects normalized kind facts while keeping invalid routing data dismissible', () => {
    const cases: [Parameters<typeof session>[0], boolean][] = [
      [{ background: true }, false],
      [{}, true],
      [{ control: { canControl: false, reason: 'background' } }, false],
      [
        { control: { canControl: true, owner: { kind: 'unclaimed', reason: 'unpublished' } } },
        true
      ],
      [{ source: 'owned', control: { canControl: false, reason: 'invalid' } }, true]
    ];
    for (const [facts, expected] of cases) {
      const card = toCard(session(facts));
      assert.equal(card.canControl, expected);
      assert.equal(card.owned, facts.source === 'owned' || undefined);
    }
  });

  it('carries the session reference only when there is a transcript to name', () => {
    const card = toCard(session({ pid: 4821, transcript: '/h/.claude/projects/x/s.jsonl' }));
    assert.equal(card.ref, '@squadron[4821][/h/.claude/projects/x/s.jsonl]');
    assert.equal('ref' in toCard(session({ transcript: '' })), false);
  });

  it('falls back to the shortened cwd when the session has no name', () => {
    assert.equal(toCard(session({ name: '', cwd: '/work/app' })).name, '/work/app');
    assert.equal(toCard(session({ name: 'titled' })).name, 'titled');
  });

  it('shows a cwd-derived name as agent-<suffix>, and leaves a title alone', () => {
    const derived = { cwd: '/work/app', nameSource: 'derived' };
    assert.equal(toCard(session({ ...derived, name: 'app-e3' })).name, 'agent-e3');
    // Titled by the CLI: not ours to rewrite, even when it starts with the dir.
    assert.equal(toCard(session({ name: 'app-e3' })).name, 'app-e3');
    assert.equal(
      toCard(session({ ...derived, name: 'Understand the turn limit' })).name,
      'Understand the turn limit'
    );
    // A suffixless derived name is all directory; there is nothing to keep.
    assert.equal(toCard(session({ ...derived, name: 'app' })).name, 'app');
  });

  it('carries the brand its source stated, and states none of its own', () => {
    // The seam answers this — `discover.ts` off `~/.claude`, `live.ts` off the
    // pipe — so a card passes it through. A source that said nothing leaves the
    // field absent rather than guessing, which is what makes the mark opt-in.
    assert.equal(toCard(session({ brand: 'claude' })).brand, 'claude');
    assert.equal(toCard(session({})).brand, undefined);
  });

  it('reads a session that never flipped status as idle since it started', () => {
    // `updatedAt` is written on the first status change, so a session younger
    // than that has none — and a card must not date it to the epoch.
    assert.equal(toCard(session({ startedAt: 1_700_000, updatedAt: 0 })).updatedAt, 1_700_000);
    assert.equal(
      toCard(session({ startedAt: 1_700_000, updatedAt: 1_800_000 })).updatedAt,
      1_800_000
    );
  });

  it('carries an owned session’s step list onto its card', () => {
    const card = toCard(
      session({ source: 'owned', status: 'idle', completion: { total: 5, completed: 5 } })
    );
    assert.deepEqual(card.completion, { total: 5, completed: 5 });
  });

  it('says nothing about progress while a session is still working', () => {
    // A busy session is mid-step by definition; a count on it would be the
    // panel contradicting itself.
    for (const status of ['busy', 'waiting', 'unknown'] as const) {
      const card = toCard(
        session({ source: 'owned', status, completion: { total: 7, completed: 3 } })
      );
      assert.equal(card.completion, undefined, `a ${status} card kept its count`);
    }
  });

  it('says the same thing about a session this window does not drive', () => {
    // The list is read off the machine, not off the pipe, so the window
    // watching a session and the window driving it show one card.
    const card = toCard(session({ status: 'idle', completion: { total: 5, completed: 5 } }));
    assert.deepEqual(card.completion, { total: 5, completed: 5 });
  });

  it('leaves a card with no step list alone', () => {
    assert.equal(toCard(session({ source: 'owned', status: 'idle' })).completion, undefined);
  });

  it('marks an idle session unseen when it replied after it was last opened', () => {
    // The whole feature: two timestamps, and the later one is the reply.
    const card = toCard(session({ status: 'idle', lastSeenAt: 1_000, updatedAt: 2_000 }));
    assert.deepEqual(card.unread, { word: 'done', tally: 'done' });
  });

  it('says nothing about delivery for a session nobody has opened', () => {
    // Otherwise the first poll after install turns every idle card on the
    // machine green at once.
    assert.equal(toCard(session({ status: 'idle', updatedAt: 2_000 })).unread, undefined);
  });

  it('drops the word once the reader has opened the session', () => {
    assert.equal(
      toCard(session({ status: 'idle', lastSeenAt: 2_000, updatedAt: 1_000 })).unread,
      undefined
    );
    // A tie is the quiet direction: opened at the moment it replied reads idle.
    assert.equal(
      toCard(session({ status: 'idle', lastSeenAt: 2_000, updatedAt: 2_000 })).unread,
      undefined
    );
  });

  it('says nothing about delivery while a session is not idle', () => {
    // `busy` and `waiting` have their own words, and `unknown` means we could
    // not read a status rather than that anything was delivered.
    for (const status of ['busy', 'waiting', 'unknown'] as const) {
      const card = toCard(session({ status, lastSeenAt: 1_000, updatedAt: 2_000 }));
      assert.equal(card.unread, undefined, `a ${status} card claimed delivery`);
    }
  });

  it('never calls a session that has not replied unseen', () => {
    // A session file written before its first status flip carries no
    // `updatedAt`. The card dates it to `startedAt` so it stays off 1970 — but
    // the word reads the raw field, or a session that has replied to nobody
    // would claim it had.
    const card = toCard(session({ status: 'idle', startedAt: 3_000, updatedAt: 0, lastSeenAt: 1 }));
    assert.equal(card.updatedAt, 3_000);
    assert.equal(card.unread, undefined);
  });

  it('resolves an idle session whose last turn failed to a failed reading', () => {
    // Nothing gates it here: the outcome rides `toSession` and the reading
    // decides whether it may speak.
    // Replied since last opened, too: failed outranks the unread `done`.
    const card = toCard(
      session({
        source: 'owned',
        status: 'idle',
        turnOutcome: 'error',
        lastSeenAt: 1_000,
        updatedAt: 2_000
      })
    );
    assert.deepEqual(card.reading, { word: 'failed', tally: 'failed' });
    assert.equal(card.unread, undefined);
  });

  it('dates attention against marks, including never-opened waiting, stalled and failed', () => {
    for (const over of [
      { status: 'waiting' as const },
      { completion: { total: 3, completed: 1 } },
      { turnOutcome: 'error' as const }
    ]) {
      assert.equal(toCard(session({ ...over, updatedAt: 2_000 })).attention, true);
      assert.equal(
        toCard(session({ ...over, updatedAt: 2_000, lastSeenAt: 1_000 })).attention,
        true
      );
      assert.equal(
        toCard(session({ ...over, updatedAt: 2_000, lastSeenAt: 2_000 })).attention,
        undefined
      );
      assert.equal(
        toCard(session({ ...over, updatedAt: 2_000, lastSeenAt: 3_000 })).attention,
        undefined
      );
    }
  });

  it('keeps a moved session’s current directory alongside where it began', () => {
    const cwd = path.resolve('/work/app');
    const liveCwd = path.resolve('/elsewhere/tree');
    const moved = toCard(session({ cwd, liveCwd }));
    assert.equal(moved.fullCwd, cwd);
    assert.equal(moved.liveCwd, liveCwd);
    const stationary = toCard(session({ cwd }));
    assert.equal(stationary.fullCwd, cwd);
    assert.equal(stationary.liveCwd, undefined);
  });

  it('carries the checkout through to the card', () => {
    const card = toCard(session({ branch: 'feat/side', worktree: true, repoRoot: '/work/app' }));
    assert.equal(card.branch, 'feat/side');
    assert.equal(card.worktree, true);
    // The root is the group's business, not the card's — it never shows.
    assert.equal('repoRoot' in card, false);
  });

  // The two flags answer for two directories once a session has moved, and the
  // chip is drawn beside the branch — so it takes the reading the branch came
  // from. Drawing the group's flag there says "worktree · main" for a session
  // standing in the main checkout, and drops the mark for one that has stepped
  // into a tree.
  it('marks the chip on the checkout the branch was read from', () => {
    const entered = toCard(
      session({ cwd: '/work/app', repoRoot: '/work/app', branch: 'side', liveWorktree: true })
    );
    assert.equal(entered.worktree, true);

    const left = toCard(
      session({
        cwd: '/work/app/.claude/worktrees/wt',
        repoRoot: '/work/app',
        worktree: true,
        branch: 'main',
        liveWorktree: false
      })
    );
    assert.equal(left.worktree, false);
  });

  it('carries a detached head', () => {
    const card = toCard(session({ branch: '3dc45c8', detached: true }));
    assert.equal(card.detached, true);
  });

  it('carries a running command through, whatever the state', () => {
    assert.equal(toCard(session({ status: 'idle', hasCommand: true })).hasCommand, true);
    assert.equal(toCard(session({ status: 'busy', hasCommand: true })).hasCommand, true);
    assert.equal(toCard(session({ status: 'waiting', hasCommand: true })).hasCommand, true);
    assert.equal(toCard(session({ hasCommand: false })).hasCommand, false);
  });

  // A guard against reintroducing the suppression the activity line needed.
  it('says a foreground Bash is a running command like any other', () => {
    const bash = session({ status: 'busy', hasCommand: true, activeTool: 'Bash' });
    assert.equal(toCard(bash).hasCommand, true);
  });

  it('carries the permission mode through as what the strip shows', () => {
    assert.deepEqual(toCard(session({ permissionMode: 'bypassPermissions' })).mode, {
      label: 'bypass',
      holds: false,
      bypass: true
    });
  });
});

describe('modeView', () => {
  it('says nothing for the mode most sessions are in', () => {
    // A word on every card saying "normal" is a row of the board spent on the
    // absence of news. Each brand's own default, since no two spell it alike.
    assert.equal(modeView('claude', 'default'), undefined);
    assert.equal(modeView('codex', 'on-request+workspaceWrite'), undefined);
  });

  it('says nothing for `default` whichever brand is holding it', () => {
    // Not a brand's word at all: it was minted off a command line, and Grok's
    // ask-mode launch is literally `--permission-mode default`. Asking
    // Grok's table about it gets it stated back, so every ask-mode Grok card
    // wore the word `default` — normal, printed, on every card.
    assert.equal(modeView('grok', 'default'), undefined);
    assert.equal(modeView('codex', 'default'), undefined);
    assert.equal(modeView(undefined, 'default'), undefined);
    assert.equal(modeView('llamaCli' as BrandId, 'default'), undefined);
  });

  it('says nothing for a mode nothing has stated yet', () => {
    // No transcript until the first turn, which is a gap of seconds — not a
    // state worth a mark of its own.
    assert.equal(modeView('claude', undefined), undefined);
  });

  it('gives each brand’s mode one word the board shares', () => {
    assert.equal(modeView('claude', 'acceptEdits')?.label, 'accept edits');
    assert.equal(modeView('claude', 'plan')?.label, 'plan');
    assert.equal(modeView('claude', 'auto')?.label, 'auto');
    assert.equal(modeView('claude', 'bypassPermissions')?.label, 'bypass');
    assert.equal(modeView('grok', 'always-approve')?.label, 'bypass');
    assert.equal(modeView('grok', 'ask')?.label, 'ask');
    assert.equal(modeView('codex', 'never+dangerFullAccess')?.label, 'bypass');
  });

  it('reads one brand’s word only for that brand', () => {
    // `never` is Codex's and means nothing to Claude; a shared table answered
    // for whichever brand spelled a word first.
    assert.equal(modeView('claude', 'never+dangerFullAccess')?.bypass, false);
    assert.equal(modeView('codex', 'bypassPermissions')?.bypass, false);
  });

  it('holds only for plan, the one mode that stops work', () => {
    assert.equal(modeView('claude', 'plan')?.holds, true);
    assert.equal(modeView('claude', 'acceptEdits')?.holds, false);
    assert.equal(modeView('claude', 'auto')?.holds, false);
    assert.equal(modeView('claude', 'bypassPermissions')?.holds, false);
  });

  it('marks bypass and nothing else', () => {
    assert.equal(modeView('claude', 'bypassPermissions')?.bypass, true);
    assert.equal(modeView('grok', 'always-approve')?.bypass, true);
    assert.equal(modeView('codex', 'never+dangerFullAccess')?.bypass, true);
    // Codex asks for nothing but is still boxed in: unattended, not unleashed.
    assert.equal(modeView('codex', 'never+workspaceWrite')?.bypass, false);
    assert.equal(modeView('codex', 'never+workspaceWrite')?.label, 'auto');
    assert.equal(modeView('claude', 'auto')?.bypass, false);
    assert.equal(modeView('grok', 'ask')?.bypass, false);
  });

  it('passes a mode it has never seen through, rather than dropping it', () => {
    // The CLI may add one; a strip that silently omits it is a strip that says
    // "nothing to report" about a mode nobody here has read.
    const unseen = modeView('claude', 'somethingNew');
    assert.equal(unseen?.label, 'somethingNew');
    // And it reads as letting work through, which is the erring-toward-warning
    // way round.
    assert.equal(unseen?.holds, false);
  });

  it('states a brand it cannot place, rather than reading it as Claude', () => {
    const foreign = modeView('llamaCli' as BrandId, 'always-approve');
    assert.equal(foreign?.label, 'always-approve');
    assert.equal(foreign?.bypass, false);
  });
});

describe('toTicketView', () => {
  it('trims a ticket to what a card shows', () => {
    const ticket: Ticket = {
      id: 'iss_1',
      scopeId: 'team-a',
      key: 'iss_1',
      identifier: 'ENG-1641',
      title: 'a bug',
      priority: ticketPriority(2),
      state: ticketState('In Progress'),
      url: 'https://linear.app/x/ENG-1641',
      branchName: 'b',
      assignee: 'me'
    };
    assert.deepEqual(toTicketView(ticket), {
      scopeId: 'team-a',
      key: 'iss_1',
      identifier: 'ENG-1641',
      title: 'a bug',
      priority: ticketPriority(2),
      state: ticketState('In Progress'),
      url: 'https://linear.app/x/ENG-1641'
    });
  });
});

describe('modelViews', () => {
  it('drops the host-only catalog facts and keeps every wire field', () => {
    // `Required<Model>` is the guard, not decoration: the projection names its
    // removals, so a host-only field added to `Model` later would ride the wire
    // with no type error. This fixture stops compiling until that field is
    // listed here, and the key set below then says whether it crossed.
    const every: Required<Model> = {
      value: 'gpt-5-codex',
      name: 'GPT-5 Codex',
      id: 'gpt-5-codex',
      brand: 'codex',
      brandLabel: 'Codex',
      readings: ['gpt-5-codex'],
      legacy: true,
      gated: true,
      fixed: true,
      window: 272_000,
      efforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      defaultEffort: 'medium',
      modalities: ['text', 'image'],
      isDefault: true,
      // Never crosses, and this is the case that proves it: a row carrying it
      // is dropped by `offeredModels` long before the push, so the projection
      // having no word for it is the whole design (`CatalogRow.unlisted`).
      unlisted: true
    };
    const [view] = modelViews([every]);
    // The three the catalog keeps to itself. `webview/` has no reader for any
    // of them, so they have no business crossing.
    assert.deepEqual(Object.keys(view ?? {}).sort(), [
      'brand',
      'brandLabel',
      'defaultEffort',
      'efforts',
      'fixed',
      'gated',
      'id',
      'legacy',
      'name',
      'readings',
      'value',
      'window'
    ]);
    assert.deepEqual(view?.efforts, [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]);
    assert.equal(view?.defaultEffort, 'medium');
  });

  it('keeps an optional the caller did state, and invents none it did not', () => {
    // A row carrying nothing optional gains nothing.
    const [bare] = modelViews([
      { value: 'opus', name: 'Opus 5', id: 'claude-opus-5', brand: 'claude' }
    ]);
    assert.deepEqual(bare, {
      value: 'opus',
      name: 'Opus 5',
      id: 'claude-opus-5',
      brand: 'claude'
    });
  });
});

describe('cache deadlines on cards', () => {
  it("states the lifetime a card is timed against, its brand's default without one", () => {
    const stated = toCard(
      session({ brand: 'grok', cache: { ttlMs: 7 * 60_000, source: 'configured' } })
    );
    assert.equal(stated.cacheTtlMs, 7 * 60_000);
    assert.equal(stated.cacheUntil, undefined);
    const bare = toCard(session({ brand: 'grok', cache: undefined }));
    assert.equal(bare.cacheTtlMs, DEFAULT_WARM_POLICY.ttlMs.grok);
  });

  it('carries the brand defaults and a configured five', () => {
    const fiveMinuteClaude: WarmPolicy = {
      ...DEFAULT_WARM_POLICY,
      ttlMs: { ...DEFAULT_WARM_POLICY.ttlMs, claude: 5 * 60_000 }
    };
    for (const [brand, policy, ttlMs] of [
      ['codex', DEFAULT_WARM_POLICY, DEFAULT_WARM_POLICY.ttlMs.codex],
      ['claude', DEFAULT_WARM_POLICY, 60 * 60_000],
      ['claude', fiveMinuteClaude, 5 * 60_000]
    ] as const) {
      const card = toCard(
        session({
          brand,
          updatedAt: 1000,
          cache: { ...cacheTtl.ttlFor(brand, policy), at: 2000 }
        })
      );
      assert.equal(card.cacheFrom, 2000);
      assert.equal(card.cacheUntil, 2000 + ttlMs);
      assert.equal(card.updatedAt, 1000);
    }
  });
});

describe('the warm row off a policy', () => {
  const MIN = 60_000;
  const port = {
    status: 'idle' as const,
    running: false,
    queued: 0,
    pending: 0,
    exited: false,
    inFlight: false
  };
  const policy: WarmPolicy = {
    ttlMs: { ...DEFAULT_WARM_POLICY.ttlMs, codex: 20 * MIN },
    marginMs: 2 * MIN,
    windowMs: 45 * MIN
  };
  const kept = (over: Partial<Parameters<typeof session>[0]>) =>
    session({
      brand: 'codex',
      warm: true,
      warmPort: port,
      updatedAt: 10 * MIN,
      cache: { ...cacheTtl.ttlFor('codex', policy), at: 10 * MIN },
      ...over
    });

  it('states the ping, the window end and the configured lifetime it was given', () => {
    assert.deepEqual(warmView(kept({}), 12 * MIN, policy), {
      on: true,
      ttlMs: 20 * MIN,
      source: 'configured',
      nextAt: 28 * MIN,
      endsAt: 55 * MIN,
      held: undefined
    });
  });

  it('holds a session whose window ends before its first ping could', () => {
    const short = { ...policy, windowMs: 15 * MIN };
    assert.equal(warmView(kept({}), 12 * MIN, short).held, 'window-short');
  });

  it('reads a session with no cache yet on the policy figure for its brand', () => {
    const view = warmView(kept({ cache: undefined, warm: false }), 12 * MIN, policy);
    assert.equal(view.ttlMs, 20 * MIN);
    assert.equal(view.source, 'configured');
  });
});
