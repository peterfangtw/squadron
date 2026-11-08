import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { warmConfig } from '../../core/cache_ttl';
import { DEFAULT_WARM_POLICY } from '../../core/warm_policy';
import { canSubmit, ChatState, eligibleCompose } from '../../ui/chat_state';
import { capture, sameDoc, type ComposeDoc, type ComposeNode } from '../../ui/compose_doc';

/** A box holding `value` as one paragraph, as the composer stashes typing. */
const box = (value: string): ComposeDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }]
});

/** The words a record's document holds; none is ''. */
const wordsOf = (value: ComposeDoc | undefined): string =>
  (value?.content ?? [])
    .map((block) => (block.content ?? []).map((node) => node.text ?? '').join(''))
    .join('\n');

const card = (pid: number, startedAt: number): CardView => ({
  pid,
  name: `session ${pid}`,
  fullCwd: '/proj',
  status: 'idle',
  reading: { word: 'idle', tally: 'idle' },
  canControl: true,
  startedAt,
  updatedAt: startedAt,
  cacheTtlMs: 60 * 60_000
});

const state = (cards: CardView[]): StateMessage => ({
  type: 'state',
  groups: [
    {
      label: 'proj',
      app: 'VS Code',
      cwd: '/proj',
      sessions: cards
    }
  ],
  cafe: false,
  cafeRemote: false,
  cafeWarm: false,
  warmOn: false,
  orchestrators: false,
  skipPermissions: false,
  executionCapture: false,
  soundLevel: 'off',
  devServers: false,
  mascot: false,
  warmCache: false,
  warmConfig: warmConfig(DEFAULT_WARM_POLICY),
  theme: 'follow',
  model: '',
  efforts: {},
  models: []
});

/** The ordered channel `ChatState.takeThread` reads. A new selection each call,
 * so a later view does not have to outrun an earlier sequence. */
const land = (chats: ChatState, view: ThreadView): boolean => {
  const activated = chats.activateSession(view.pid, view.startedAt);
  const active = chats.active();
  if (
    activated === undefined ||
    active?.kind !== 'session' ||
    active.pid !== view.pid ||
    active.startedAt !== view.startedAt
  )
    return false;
  return chats.takeThread({
    type: 'thread',
    selection: chats.requestSelection(),
    generation: 1,
    sequence: 1,
    thread: view
  });
};

const thread = (pid: number, startedAt: number): ThreadView => ({
  ...card(pid, startedAt),
  owned: true,
  exchanges: [],
  canSend: true,
  canAttach: true,
  who: 'claude'
});

describe('ChatState', () => {
  it('freezes a launch choice until a refused startup can be retried', () => {
    const chats = new ChatState();
    const cwd = '/proj';
    const cold = { ...state([]), model: 'gpt-6.1-sol', contextWindow: 123_000 };
    chats.openDraft(cwd);
    const seed = chats.context(cold)?.pick;
    assert.ok(seed);
    assert.ok(Object.isFrozen(seed));
    const attempt = chats.beginDraftStart(cwd, 1);
    assert.ok(attempt);
    const ready = {
      ...cold,
      models: [
        {
          brand: 'codex' as const,
          value: 'gpt-6.1-sol',
          id: 'gpt-6.1-sol',
          name: 'Sol 6.1',
          window: 475_000,
          efforts: [{ value: 'medium' }],
          defaultEffort: 'medium'
        }
      ]
    };
    assert.deepEqual(chats.context(ready)?.pick, seed);
    assert.deepEqual(chats.draftFor(cwd)?.pick, seed);
    chats.refuseDraft(attempt, 'Try again');
    const retried = chats.context(ready);
    assert.equal(retried?.pick?.window, 475_000);
    assert.equal(retried?.pick?.effort, 'medium');
    assert.equal(retried?.reason, 'Try again');
    assert.ok(Object.isFrozen(retried?.pick));
  });

  it('keeps independent compose records while switching', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000), card(2, 2000)]));
    assert.equal(chats.activateSession(1), true);
    const one = chats.active();
    assert.ok(one);
    chats.edit(one, { doc: box('one'), workflowId: 'ship' });
    chats.activateSession(2);
    const two = chats.active();
    assert.ok(two);
    chats.edit(two, { doc: box('two') });
    chats.activateSession(1);
    assert.deepEqual(chats.compose(), { doc: box('one'), workflowId: 'ship' });
    assert.equal(wordsOf(chats.session(2)?.compose.doc), 'two');
  });

  it('settles reordered sends against their own operation and owner', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000), card(2, 2000)]));
    const a = chats.beginSend(1, {
      delivered: 'wire A',
      images: [],
      doc: box('typed A'),
      at: 1
    });
    const b = chats.beginSend(2, {
      delivered: 'wire B',
      images: [],
      doc: box('typed B'),
      at: 2
    });
    assert.ok(a && b);
    chats.settleSend(2, 2000, b.operationId, true, undefined, 'enriched B');
    chats.settleSend(1, 1000, a.operationId, false, 'A refused');
    assert.equal(wordsOf(chats.session(1)?.compose.doc), 'typed A');
    assert.equal(chats.session(1)?.refusal, 'A refused');
    assert.equal(chats.session(2)?.pending[0]?.delivered, 'enriched B');
  });

  it('sends a pick with the next message only, until it is picked again', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    const send = (at: number) =>
      chats.beginSend(1, { delivered: `m${at}`, images: [], doc: box(`m${at}`), at });
    chats.chooseTarget(1, { effort: 'high' });
    assert.deepEqual(send(1)?.target, { effort: 'high' });
    assert.equal(send(2)?.target, undefined, 'the pick went out with every message');
    assert.deepEqual(chats.session(1)?.target, { effort: 'high' }, 'the pill lost the pick');
    chats.chooseTarget(1, { effort: 'high' });
    assert.deepEqual(send(3)?.target, { effort: 'high' }, 'a second pick is an act of its own');
  });

  it('sends the pick again once the message that carried it is refused', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    const send = (at: number) =>
      chats.beginSend(1, { delivered: `m${at}`, images: [], doc: box(`m${at}`), at });
    chats.chooseTarget(1, { effort: 'high' });
    const carried = send(1);
    assert.ok(carried);
    chats.settleSend(1, 1000, carried.operationId, false, 'refused');
    assert.deepEqual(send(2)?.target, { effort: 'high' });
  });

  it('does not replace newer typing when an earlier send is refused', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    const sent = chats.beginSend(1, {
      delivered: 'first',
      images: [],
      doc: box('first'),
      at: 1
    });
    assert.ok(sent);
    chats.edit({ kind: 'session', pid: 1, startedAt: 1000 }, { doc: box('newer') });
    const result = chats.settleSend(1, 1000, sent.operationId, false, 'refused');
    assert.equal(result.restored, false);
    assert.equal(wordsOf(chats.session(1)?.compose.doc), 'newer');
    assert.equal(chats.session(1)?.failed[0]?.delivered, 'first');
  });

  it('promotes one draft attempt without changing another active chat', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    const draft = chats.openDraft('/other');
    const active = chats.active();
    assert.ok(active);
    chats.edit(active, { doc: box('start me') });
    const id = chats.beginDraftStart('/other', 1);
    assert.ok(id);
    chats.activateSession(1);
    const promotion = chats.bindSession(id, 2, 2000);
    assert.equal(promotion?.active, false);
    assert.equal(chats.selected(), 1);
    assert.equal(wordsOf(chats.session(2)?.compose.doc), 'start me');
    assert.equal(chats.draftFor(draft.cwd), undefined);
  });

  it('snapshots a draft launch target on input', () => {
    const chats = new ChatState();
    chats.openDraft('/proj');
    const pick = { brand: 'claude' as const, model: 'opus', window: 200_000, effort: 'high' };
    chats.setDraftPick('/proj', pick);

    pick.model = 'haiku';
    pick.window = 1;
    assert.deepEqual(chats.draftFor('/proj')?.pick, {
      brand: 'claude',
      model: 'opus',
      window: 200_000,
      effort: 'high'
    });
  });

  it('does not expose the active identity through a promotion result', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const id = chats.beginDraftStart(draft.cwd, 1);
    assert.ok(id);
    const promotion = chats.bindSession(id, 7, 7000);
    assert.ok(promotion);

    promotion.owner.pid = 8;
    promotion.owner.startedAt = 8000;
    assert.deepEqual(chats.active(), { kind: 'session', pid: 7, startedAt: 7000 });
  });

  it('retires state and ignores stale threads and file results after pid reuse', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    assert.equal(land(chats, thread(1, 1000)), true);
    const pick = chats.beginFilePick({ kind: 'session', pid: 1, startedAt: 1000 });
    assert.ok(pick);
    chats.observe(state([card(1, 20_000)]));
    assert.equal(land(chats, thread(1, 1000)), false);
    assert.equal(chats.session(1)?.thread, undefined);
    // The id alone is the address now, and it still finds nothing: the reused
    // pid got a fresh record whose set never held it.
    assert.equal(chats.settleFilePick(pick.operationId), undefined);
  });

  it('keeps a dialog operation with its session while another chat is active', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000), card(2, 2000)]));
    chats.syncDialogs(1, 1000, ['ask-1']);
    chats.editDialog(1, 1000, 'ask-1', (dialog) => {
      dialog.reply = 'because';
      dialog.sending = 'reply';
    });

    chats.activateSession(2);
    chats.settleDialog(1, 1000, 'ask-1', false, 'window refused');
    assert.deepEqual(chats.dialog(1, 1000, 'ask-1'), {
      picks: new Map(),
      texts: new Map(),
      others: new Set(),
      notes: new Map(),
      noting: new Set(),
      reply: 'because',
      bail: false,
      shown: 0,
      cur: -1,
      sending: undefined,
      failure: 'window refused'
    });
  });

  it('retires dialog state with a recycled pid', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    chats.syncDialogs(1, 1000, ['ask-1']);
    chats.editDialog(1, 1000, 'ask-1', (dialog) => {
      dialog.reply = 'old answer';
    });

    chats.observe(state([card(1, 20_000)]));
    chats.syncDialogs(1, 20_000, ['ask-1']);
    assert.equal(chats.dialog(1, 1000, 'ask-1'), undefined);
    assert.equal(chats.dialog(1, 20_000, 'ask-1')?.reply, '');
  });

  it('does not reconcile the same transcript candidate twice', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    const first = chats.beginSend(1, {
      delivered: 'same',
      images: [],
      doc: box('same'),
      at: 1
    });
    const second = chats.beginSend(1, {
      delivered: 'same',
      images: [],
      doc: box('same'),
      at: 2
    });
    assert.ok(first && second);

    chats.syncEchoCandidates(1, 1000, ['text:same']);
    assert.equal(chats.reconcileEcho(1, 1000, first.operationId, ['text:same']), true);
    assert.equal(chats.reconcileEcho(1, 1000, second.operationId, ['text:same']), false);
    chats.syncEchoCandidates(1, 1000, ['text:same']);
    assert.equal(chats.reconcileEcho(1, 1000, second.operationId, ['text:same']), false);
    chats.syncEchoCandidates(1, 1000, ['text:same', 'text:same']);
    assert.equal(
      chats.reconcileEcho(1, 1000, second.operationId, ['text:same', 'text:same']),
      true
    );
  });

  it('does not reconcile a fresh send against an identical historical turn', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    assert.equal(
      land(chats, {
        ...thread(1, 1000),
        exchanges: [{ role: 'user', text: 'same', blocks: [{ prose: 'same' }] }]
      }),
      true
    );
    const sent = chats.beginSend(1, {
      delivered: 'same',
      images: [],
      doc: box('same'),
      at: 1
    });
    assert.ok(sent);

    chats.syncEchoCandidates(1, 1000, ['text:same']);
    assert.equal(chats.reconcileEcho(1, 1000, sent.operationId, ['text:same']), false);
    chats.syncEchoCandidates(1, 1000, ['text:same', 'text:same']);
    assert.equal(chats.reconcileEcho(1, 1000, sent.operationId, ['text:same', 'text:same']), true);
  });

  it('does not reuse operation ids after a document reload', () => {
    const oldDocument = new ChatState();
    const newDocument = new ChatState();
    oldDocument.observe(state([card(1, 1000)]));
    newDocument.observe(state([card(1, 1000)]));
    const owner = { kind: 'session', pid: 1, startedAt: 1000 } as const;
    const oldPick = oldDocument.beginFilePick(owner);
    const newPick = newDocument.beginFilePick(owner);
    assert.ok(oldPick && newPick);
    assert.notEqual(oldPick.operationId, newPick.operationId);
    assert.equal(
      newDocument.settleFilePick(oldPick.operationId),
      undefined,
      'a disposed document settled the new document operation'
    );
  });

  it('rejects an older reveal and merges a matching state-before-reveal record', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 20_000)]));
    assert.equal(land(chats, thread(1, 20_000)), true);
    const stale = chats.openDraft('/stale');
    chats.edit({ kind: 'draft', cwd: stale.cwd }, { doc: box('old') });
    const staleId = chats.beginDraftStart(stale.cwd, 1);
    assert.ok(staleId);
    assert.equal(chats.bindSession(staleId, 1, 1000), undefined);
    assert.equal(chats.session(1)?.identity.startedAt, 20_000);
    assert.equal(wordsOf(chats.draftFor(stale.cwd)?.doc), 'old');
    chats.observe(state([card(1, 1000)]));
    assert.equal(land(chats, thread(1, 1000)), false);
    assert.equal(chats.session(1)?.identity.startedAt, 20_000);

    const current = chats.openDraft('/current');
    chats.edit({ kind: 'draft', cwd: current.cwd }, { doc: box('new') });
    const currentId = chats.beginDraftStart(current.cwd, 2);
    assert.ok(currentId);
    assert.ok(chats.bindSession(currentId, 1, 20_000));
    assert.equal(wordsOf(chats.session(1)?.compose.doc), 'new');
    assert.equal(chats.session(1)?.thread?.startedAt, 20_000);
  });

  it('keeps a draft whose workflow the reader picked', () => {
    const chats = new ChatState();
    chats.openDraft('/proj');
    chats.edit({ kind: 'draft', cwd: '/proj' }, { workflowId: 'spike' });
    chats.closeDraft();
    assert.equal(chats.draftFor('/proj')?.workflowId, 'spike');
  });

  it('discards a draft holding nothing', () => {
    const chats = new ChatState();
    chats.openDraft('/proj');
    chats.closeDraft();
    assert.equal(chats.draftFor('/proj'), undefined);
  });

  it('keeps workflow folds and dialog mutation handles owner-local', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000), card(2, 2000)]));
    const first = { kind: 'session', pid: 1, startedAt: 1000 } as const;
    const second = { kind: 'session', pid: 2, startedAt: 2000 } as const;
    chats.setWorkflowFold(first, 'ship', true);
    assert.equal(chats.workflowFolded(first, 'ship'), true);
    assert.equal(chats.workflowFolded(second, 'ship'), false);

    chats.syncDialogs(1, 1000, ['ask-1']);
    let edit: import('../../ui/chat_state').DialogEdit | undefined;
    chats.editDialog(1, 1000, 'ask-1', (dialog) => {
      dialog.reply = 'committed';
      edit = dialog;
    });
    assert.ok(edit);
    edit.reply = 'escaped';
    assert.equal(chats.dialog(1, 1000, 'ask-1')?.reply, 'committed');
  });

  it('keeps nested compose values behind the interface', () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    chats.activateSession(1);
    const owner = chats.active();
    assert.ok(owner);
    const written = box('mine');
    chats.edit(owner, { doc: written });

    const block = written.content[0];
    assert.ok(block?.content?.[0]);
    block.content[0].text = 'outside';
    assert.equal(wordsOf(chats.compose()?.doc), 'mine');

    const compose = chats.compose();
    assert.ok(compose?.doc);
    const stored = compose.doc.content[0]?.content?.[0];
    assert.ok(stored);
    assert.throws(() => {
      stored.text = 'escaped';
    });
    assert.equal(wordsOf(chats.compose()?.doc), 'mine');
  });

  it('keeps nested anchors and thread data behind the interface', () => {
    const chats = new ChatState();
    const view = {
      ...thread(1, 1000),
      workflow: {
        label: 'ship',
        phase: 'running' as const,
        steps: [{ id: 'build', label: 'Build', status: 'in_progress' as const }]
      }
    };
    chats.observe(state([card(1, 1000)]));
    assert.equal(land(chats, view), true);
    chats.activateSession(1);
    const anchors = [{ key: 'turn-1', index: 0, delta: 4 }];
    chats.saveAnchors(1, anchors);

    const inputStep = view.workflow.steps[0];
    const inputAnchor = anchors[0];
    assert.ok(inputStep && inputAnchor);
    inputStep.label = 'Outside';
    inputAnchor.delta = 99;
    assert.equal(chats.thread()?.workflow?.steps?.[0]?.label, 'Build');
    assert.equal(chats.anchorsFor(1)[0]?.delta, 4);

    const exposedThread = chats.thread();
    const exposedAnchors = chats.anchorsFor(1);
    const exposedStep = exposedThread?.workflow?.steps?.[0];
    const exposedAnchor = exposedAnchors[0];
    assert.ok(exposedStep && exposedAnchor);
    assert.throws(() => {
      exposedStep.label = 'Escaped';
    });
    assert.throws(() => {
      exposedAnchor.delta = 7;
    });
    assert.equal(chats.session(1)?.thread?.workflow?.steps?.[0]?.label, 'Build');
    assert.equal(chats.anchorsFor(1)[0]?.delta, 4);
  });

  const payload = (typed: string, at = 1): import('../../ui/chat_state').SendInput => ({
    delivered: typed,
    images: [],
    doc: box(typed),
    at
  });

  it('binds one record without copying compose onto a replacement', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const owner = chats.active();
    assert.ok(owner);
    chats.edit(owner, { doc: box('start me'), workflowId: 'ship' });
    const id = chats.beginDraftStart(draft.cwd, 1);
    assert.ok(id);
    const bound = chats.bindSession(id, 7, 7000);
    assert.ok(bound);
    assert.equal(chats.draftFor('/proj'), undefined);
    assert.equal(wordsOf(chats.session(7)?.compose.doc), 'start me');
    assert.equal(chats.session(7)?.compose.workflowId, 'ship');
    assert.deepEqual(chats.active(), { kind: 'session', pid: 7, startedAt: 7000 });
  });

  it('keeps a held snapshot off live compose, including through beginSend', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: draft.cwd };
    chats.edit(owner, { doc: box('hello') });
    const held = chats.holdSubmit(owner, payload('hello', 10));
    assert.ok(held);
    assert.equal(chats.composeFor(owner)?.doc, undefined);
    chats.edit(owner, { doc: box('later') });
    const id = chats.beginDraftStart(draft.cwd, 1);
    assert.ok(id);
    const bound = chats.bindSession(id, 8, 8000);
    const snapshot = bound?.snapshot;
    assert.ok(snapshot);
    assert.equal(snapshot.delivered, 'hello');
    const sent = chats.beginSend(8, snapshot);
    assert.ok(sent);
    assert.equal(wordsOf(chats.session(8)?.compose.doc), 'later');
  });

  it('does not clear a later identical box when sending the held snapshot', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: draft.cwd };
    chats.edit(owner, { doc: box('/tmp/same.ts ') });
    const held = chats.holdSubmit(owner, payload('/tmp/same.ts ', 10));
    assert.ok(held);
    chats.edit(owner, { doc: box('/tmp/same.ts ') });
    const id = chats.beginDraftStart(draft.cwd, 1);
    assert.ok(id);
    const bound = chats.bindSession(id, 8, 8000);
    assert.ok(bound?.snapshot);
    const sent = chats.beginSend(8, bound.snapshot);
    assert.ok(sent);
    assert.equal(wordsOf(chats.session(8)?.compose.doc), '/tmp/same.ts ');
  });

  it('does not send twice for a second bind of the same attempt', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const id = chats.beginDraftStart(draft.cwd, 1);
    assert.ok(id);
    assert.ok(chats.bindSession(id, 8, 8000));
    assert.equal(chats.bindSession(id, 8, 8000), undefined);
    assert.equal(chats.draftById(id), undefined);
  });

  it('keeps the held snapshot on fail without recapturing into compose', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: draft.cwd };
    chats.holdSubmit(owner, payload('hello', 10));
    const id = chats.beginDraftStart(draft.cwd, 1);
    assert.ok(id);
    chats.failDraftStart(id, 'Nothing came up in this folder.');
    assert.equal(wordsOf(chats.draftFor(draft.cwd)?.doc), '');
    assert.equal(chats.heldFor(owner)?.delivered, 'hello');

    chats.edit(owner, { doc: box('newer') });
    const retry = chats.beginDraftStart(draft.cwd, 2);
    assert.ok(retry);
    chats.failDraftStart(retry, 'Nothing came up in this folder.');
    assert.equal(wordsOf(chats.draftFor(draft.cwd)?.doc), 'newer');
    assert.equal(chats.heldFor(owner)?.delivered, 'hello');
    chats.dismissHeld(owner);
    assert.equal(chats.heldFor(owner), undefined);
    assert.equal(wordsOf(chats.draftFor(draft.cwd)?.doc), 'newer');
  });

  it('does not drop a held snapshot as a disposable empty draft', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: draft.cwd };
    chats.holdSubmit(owner, payload('keep me', 10));
    chats.closeDraft();
    assert.ok(chats.draftFor(draft.cwd), 'a held snapshot was discarded as empty');
    assert.equal(chats.heldFor(owner)?.delivered, 'keep me');
  });

  it('merges compose from a session observed before reveal', () => {
    const chats = new ChatState();
    const draft = chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: draft.cwd };
    chats.holdSubmit(owner, payload('hello', 10));
    const id = chats.beginDraftStart(draft.cwd, 1);
    assert.ok(id);
    chats.observe(state([card(8, 8000)]));
    chats.activateSession(8, 8000);
    chats.edit({ kind: 'session', pid: 8, startedAt: 8000 }, { doc: box('on the card') });
    const bound = chats.bindSession(id, 8, 8000);
    assert.ok(bound);
    assert.equal(bound.snapshot?.delivered, 'hello');
    assert.equal(wordsOf(chats.session(8)?.compose.doc), 'on the card');
  });
});

const text = (value: string, marks: string[] = []): ComposeNode => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {})
});
const para = (...content: ComposeNode[]): ComposeNode => ({
  type: 'paragraph',
  ...(content.length ? { content } : {})
});
const chip = (
  kind: string,
  expansion: string,
  attachmentId: string | null = null
): ComposeNode => ({
  type: 'chip',
  attrs: { kind, expansion, attachmentId }
});
const doc = (...content: ComposeNode[]): ComposeDoc => ({
  type: 'doc',
  content: content.length ? content : [para()]
});
const png = (name: string): ComposerImage => ({
  name,
  mediaType: 'image/png',
  dataUrl: `data:image/png;base64,${name}`
});
const expansions = (value: ComposeDoc): string[] =>
  value.content.flatMap((block) =>
    (block.content ?? []).flatMap((node) =>
      node.type === 'chip' ? [String(node.attrs?.expansion)] : []
    )
  );
const quoted: ComposeNode = { type: 'blockquote', content: [para(text('quoted'))] };
const listed: ComposeNode = {
  type: 'bulletList',
  content: [{ type: 'listItem', content: [para(text('item'))] }]
};
const fenced: ComposeNode = { type: 'codeBlock', content: [text('code')] };
const ready = { bound: true, liveRun: false, starting: false, canSend: true };

describe('ChatState with the editor document', () => {
  const session = (): {
    chats: ChatState;
    owner: { kind: 'session'; pid: number; startedAt: number };
  } => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000)]));
    chats.activateSession(1);
    return { chats, owner: { kind: 'session', pid: 1, startedAt: 1000 } };
  };

  /** Captures the active box as the composer would, with the given delivery. */
  const sendInput = (
    chats: ChatState,
    delivered: string,
    at: number
  ): import('../../ui/chat_state').SendInput => {
    const compose = chats.compose();
    assert.ok(compose?.doc);
    const captured = capture(compose.doc, compose.pool ?? {});
    return {
      delivered,
      images: captured.images,
      doc: compose.doc,
      attachments: captured.attachments,
      at
    };
  };

  it('leaves the box empty when its last image is deleted, the bytes still pooled', () => {
    const { chats, owner } = session();
    const id = chats.attach(owner, { kind: 'image', image: png('A') });
    assert.ok(id);
    chats.edit(owner, { doc: doc(para(chip('image', '[Image #1]', id))) });
    const holding = chats.compose();
    assert.ok(holding);
    assert.equal(eligibleCompose(holding, false), true);

    chats.edit(owner, { doc: doc() });
    const compose = chats.compose();
    assert.ok(compose?.doc);
    assert.equal(eligibleCompose(compose, false), false);
    assert.equal(canSubmit(compose, ready), false);
    assert.deepEqual(compose.pool?.[id], { kind: 'image', image: png('A') });
    assert.deepEqual(capture(compose.doc, compose.pool ?? {}).images, []);
  });

  it('discards a draft whose only image was deleted', () => {
    const chats = new ChatState();
    chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: '/proj' };
    const id = chats.attach(owner, { kind: 'image', image: png('A') });
    assert.ok(id);
    chats.edit(owner, { doc: doc(para(chip('image', '[Image #1]', id))) });
    chats.edit(owner, { doc: doc() });
    chats.closeDraft();
    assert.equal(chats.draftFor('/proj'), undefined);
  });

  it('restores a refused send into a box its document says is empty', () => {
    const { chats, owner } = session();
    const a = chats.attach(owner, { kind: 'image', image: png('A') });
    assert.ok(a);
    const sentDoc = doc(para(text('look '), chip('image', '[Image #1]', a)));
    chats.edit(owner, { doc: sentDoc });
    const sent = chats.beginSend(1, sendInput(chats, 'look [Image #1]', 1));
    assert.ok(sent);
    assert.equal(chats.compose()?.doc, undefined);
    assert.equal(chats.compose()?.pool, undefined);

    // An image pasted and deleted since: pooled, and the box still empty.
    const b = chats.attach(owner, { kind: 'image', image: png('B') });
    assert.ok(b);
    chats.edit(owner, { doc: doc(para(chip('image', '[Image #1]', b))) });
    chats.edit(owner, { doc: doc() });

    const result = chats.settleSend(1, 1000, sent.operationId, false, 'refused');
    assert.equal(result.restored, true);
    const compose = chats.compose();
    assert.deepEqual(compose?.doc, sentDoc);
    assert.deepEqual(compose?.pool, { [a]: { kind: 'image', image: png('A') } });
    assert.equal(chats.session(1)?.failed.length, 0);
  });

  it('keeps a refused send recoverable while the box holds the next message', () => {
    const { chats, owner } = session();
    const a = chats.attach(owner, { kind: 'image', image: png('A') });
    assert.ok(a);
    const sentDoc = doc(para(text('look '), chip('image', '[Image #1]', a)));
    chats.edit(owner, { doc: sentDoc });
    const sent = chats.beginSend(1, sendInput(chats, 'look [Image #1]', 1));
    assert.ok(sent);
    const next = doc(para(text('newer')));
    chats.edit(owner, { doc: next });

    const result = chats.settleSend(1, 1000, sent.operationId, false, 'refused');
    assert.equal(result.restored, false);
    assert.deepEqual(chats.compose()?.doc, next);
    const failed = chats.session(1)?.failed[0];
    assert.deepEqual(failed?.doc, sentDoc);
    assert.deepEqual(failed?.attachments, { [a]: { kind: 'image', image: png('A') } });

    assert.equal(chats.recoverFailed(1, sent.operationId), false);
    chats.edit(owner, { doc: doc() });
    assert.equal(chats.recoverFailed(1, sent.operationId), true);
    assert.deepEqual(chats.compose()?.doc, sentDoc);
    assert.deepEqual(chats.compose()?.pool, { [a]: { kind: 'image', image: png('A') } });
  });

  it('keeps the document apart from the delivery the host settles', () => {
    const { chats, owner } = session();
    chats.edit(owner, { doc: doc(para(text('ship it'))) });
    const sent = chats.beginSend(1, sendInput(chats, 'ship it', 1));
    assert.ok(sent);
    chats.settleSend(1, 1000, sent.operationId, true, undefined, 'ship it\n\n[workflow]');
    const echo = chats.session(1)?.pending[0];
    assert.equal(echo?.delivered, 'ship it\n\n[workflow]');
    assert.deepEqual(echo?.doc, doc(para(text('ship it'))));
  });

  it('sends a held retry as it was captured, not as the box reads now', () => {
    const chats = new ChatState();
    chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: '/proj' };
    const a = chats.attach(owner, { kind: 'image', image: png('A') });
    assert.ok(a);
    const first = doc(para(text('first '), chip('image', '[Image #1]', a)));
    chats.edit(owner, { doc: first });
    const held = chats.holdSubmit(owner, sendInput(chats, 'first [Image #1]', 10));
    assert.ok(held?.doc);
    const heldDoc = held.doc;
    assert.equal(chats.composeFor(owner)?.doc, undefined);
    assert.equal(chats.composeFor(owner)?.pool, undefined);
    assert.throws(() => {
      heldDoc.content.push(para());
    });

    const b = chats.attach(owner, { kind: 'image', image: png('B') });
    assert.ok(b);
    const second = doc(para(text('second '), chip('image', '[Image #1]', b)));
    chats.edit(owner, { doc: second });
    const id = chats.beginDraftStart('/proj', 1);
    assert.ok(id);
    const bound = chats.bindSession(id, 8, 8000);
    assert.ok(bound?.snapshot);
    assert.deepEqual(bound.snapshot.doc, first);
    assert.deepEqual(Object.keys(bound.snapshot.attachments ?? {}), [a]);

    const sent = chats.beginSend(8, bound.snapshot);
    assert.ok(sent);
    assert.equal(sent.delivered, 'first [Image #1]');
    assert.deepEqual(bound.snapshot.images, [png('A')]);
    assert.deepEqual(sent.doc, first);
    assert.deepEqual(chats.session(8)?.compose.doc, second);
    assert.deepEqual(chats.session(8)?.compose.pool, { [b]: { kind: 'image', image: png('B') } });
  });

  const skill = chip('skill', 'the design skill');

  it('keeps a picked skill chip through promotion onto a fresh record', () => {
    const chats = new ChatState();
    chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: '/proj' };
    const picked = doc(para(text('use '), skill));
    chats.edit(owner, { doc: picked });
    const id = chats.beginDraftStart('/proj', 1);
    assert.ok(id);
    assert.ok(chats.bindSession(id, 8, 8000));
    chats.observe(state([card(8, 8000)]));
    assert.deepEqual(chats.session(8)?.compose.doc, picked);
  });

  it('keeps a picked skill chip through promotion onto a record observed first', () => {
    const chats = new ChatState();
    chats.openDraft('/proj');
    const owner = { kind: 'draft' as const, cwd: '/proj' };
    chats.edit(owner, { doc: doc(para(text('use '), skill)) });
    const id = chats.beginDraftStart('/proj', 1);
    assert.ok(id);
    chats.observe(state([card(8, 8000)]));
    chats.edit(
      { kind: 'session', pid: 8, startedAt: 8000 },
      { doc: doc(para(text('on the card'))) }
    );
    assert.ok(chats.bindSession(id, 8, 8000));
    assert.deepEqual(
      chats.session(8)?.compose.doc,
      doc(para(text('use '), skill), para(text('on the card')))
    );
  });

  for (const [name, last] of [
    ['a quote', quoted],
    ['a list', listed],
    ['a fence', fenced]
  ] as const) {
    it(`appends after ${name} as the last block without opening it`, () => {
      const chats = new ChatState();
      chats.openDraft('/proj');
      const owner = { kind: 'draft' as const, cwd: '/proj' };
      const mine = chats.attach(owner, { kind: 'image', image: png('D') });
      assert.ok(mine);
      chats.edit(owner, { doc: doc(para(chip('image', '[Image #1]', mine)), last) });
      const id = chats.beginDraftStart('/proj', 1);
      assert.ok(id);
      chats.observe(state([card(8, 8000)]));
      const card8 = { kind: 'session' as const, pid: 8, startedAt: 8000 };
      const theirs = chats.attach(card8, { kind: 'image', image: png('S') });
      assert.ok(theirs);
      chats.edit(card8, { doc: doc(para(text('tail '), chip('image', '[Image #1]', theirs))) });
      assert.ok(chats.bindSession(id, 8, 8000));

      const merged = chats.session(8)?.compose;
      assert.ok(merged?.doc);
      assert.deepEqual(merged.doc.content, [
        para(chip('image', '[Image #1]', mine)),
        last,
        para(text('tail '), chip('image', '[Image #1]', theirs))
      ]);
      assert.deepEqual(Object.keys(merged.pool ?? {}).sort(), [mine, theirs].sort());
      assert.deepEqual(capture(merged.doc, merged.pool ?? {}).images, [png('D'), png('S')]);

      // A ticket handed to a box nobody is looking at: the same append.
      chats.edit(card8, { doc: doc(para(text('mine')), last) });
      chats.append(card8, doc(para(text('ticket'))));
      assert.deepEqual(chats.session(8)?.compose.doc?.content, [
        para(text('mine')),
        last,
        para(text('ticket'))
      ]);
    });
  }

  it('appends into an empty box without a blank first block', () => {
    const { chats, owner } = session();
    chats.append(owner, doc(para(text('ticket'))));
    assert.deepEqual(chats.compose()?.doc, doc(para(text('ticket'))));
    chats.edit(owner, { doc: doc() });
    chats.append(owner, doc(para(text('again'))));
    assert.deepEqual(chats.compose()?.doc, doc(para(text('again'))));
    chats.edit(owner, { doc: doc(para(text('  ')), para({ type: 'hardBreak' })) });
    chats.append(owner, doc(para(text('blank before'))));
    assert.deepEqual(chats.compose()?.doc, doc(para(text('blank before'))));
  });

  it('keeps both images in order through deleting and undoing the first', () => {
    const { chats, owner } = session();
    const a = chats.attach(owner, { kind: 'image', image: png('A') });
    const b = chats.attach(owner, { kind: 'image', image: png('B') });
    assert.ok(a && b);
    const both = doc(
      para(chip('image', '[Image #1]', a), text(' and '), chip('image', '[Image #2]', b))
    );
    chats.edit(owner, { doc: both });
    chats.edit(owner, { doc: doc(para(text(' and '), chip('image', '[Image #2]', b))) });
    let compose = chats.compose();
    assert.ok(compose?.doc);
    let captured = capture(compose.doc, compose.pool ?? {});
    assert.deepEqual(captured.images, [png('B')]);
    assert.deepEqual(expansions(captured.wire), ['[Image #1]']);
    assert.deepEqual(Object.keys(captured.attachments), [b]);

    chats.edit(owner, { doc: both });
    compose = chats.compose();
    assert.ok(compose?.doc);
    captured = capture(compose.doc, compose.pool ?? {});
    assert.deepEqual(captured.images, [png('A'), png('B')]);
    assert.deepEqual(expansions(captured.wire), ['[Image #1]', '[Image #2]']);
  });

  it('keeps identical bytes pasted twice as two attachments', () => {
    const { chats, owner } = session();
    const a = chats.attach(owner, { kind: 'image', image: png('A') });
    const again = chats.attach(owner, { kind: 'image', image: png('A') });
    assert.ok(a && again);
    assert.notEqual(a, again);
    chats.edit(owner, {
      doc: doc(para(chip('image', '[Image #1]', a), chip('image', '[Image #1]', again)))
    });
    const compose = chats.compose();
    assert.ok(compose?.doc);
    const captured = capture(compose.doc, compose.pool ?? {});
    assert.deepEqual(captured.images, [png('A'), png('A')]);
    assert.deepEqual(expansions(captured.wire), ['[Image #1]', '[Image #2]']);
  });

  it("drops a deleted chip's bytes once the box changes owner", () => {
    const chats = new ChatState();
    chats.observe(state([card(1, 1000), card(2, 2000)]));
    chats.activateSession(1);
    const owner = { kind: 'session' as const, pid: 1, startedAt: 1000 };
    const kept = chats.attach(owner, { kind: 'image', image: png('A') });
    const gone = chats.attach(owner, { kind: 'image', image: png('B') });
    assert.ok(kept && gone);
    chats.edit(owner, { doc: doc(para(chip('image', '[Image #1]', kept))) });
    chats.activateSession(1);
    assert.deepEqual(Object.keys(chats.compose()?.pool ?? {}).sort(), [kept, gone].sort());

    chats.activateSession(2);
    assert.deepEqual(Object.keys(chats.session(1)?.compose.pool ?? {}), [kept]);
  });

  it('compares documents, not their delivery, to tell what was sent', () => {
    const { chats, owner } = session();
    const bold = doc(para(text('x', ['bold'])));
    const literal = doc(para(text('**x**')));
    assert.equal(sameDoc(bold, literal), false);
    assert.equal(sameDoc(literal, doc(para(text('**x**')))), true);

    chats.edit(owner, { doc: literal });
    const input = {
      delivered: '**x**',
      images: [],
      doc: bold,
      at: 1
    };
    assert.ok(chats.beginSend(1, input));
    assert.deepEqual(chats.compose()?.doc, literal);

    assert.ok(chats.beginSend(1, { ...input, doc: literal, at: 2 }));
    assert.equal(chats.compose()?.doc, undefined);
  });
});
