/**
 * The message box: the prose editor (`prose.ts`) on `#input`. Its document is
 * the record (`ComposeState.doc`). A mention or an attachment is a chip in it,
 * and a send captures the document.
 */

import { $, ctxLabel, el, imeKey, typingIn } from './dom';
import { chats, input, panelDrives, ui, vscode } from './state';
import { canSubmit, eligibleCompose, type ComposeState, type SendInput } from '../ui/chat_state';
import { capture, blank, sameDoc, showComposeHint, type ComposeDoc } from '../ui/compose_doc';
import { CACHE_NOTE, cacheGone, modelMenuBody } from './board';
import { effortMenuBody } from './board_settings';
import { findCard } from './board_card';
import { endable, openRename, renderActive, startupHolding, submitRename } from './chat';
import { startDraft } from './board_nav';
import { dropdownTrigger, heldOpen, opensMenu, paintIfChanged } from './kit';
import { editing, openCreate, openEdit } from './editor';
import { isOpen, render, toggleDrawer } from './workflow_overview_drawer';
import { picker } from './picker';
import { attachMentions, type Mention } from './mentions';
import { createProse, deliveryOf } from './prose';
import { attachFormatbar } from './formatbar';
import { resolveModel } from '../core/model_names';
import { isMidTurn, sameSessionStart } from '../core/model';
import { icon } from '../ui/icons';
import { lightboxOpen } from './lightbox';

/**
 * What the CLI attaches, copied from `pastes.ts` because this bundle cannot
 * import it. The CLI checks the file extension, then silently drops a type it
 * cannot decode, so the panel refuses any other type here.
 */
const PASTEABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** A limit on the trip to the host. The CLI downscales to its own budget. */
const MAX_PASTE_BYTES = 10 * 1024 * 1024;

/**
 * One editor for the life of the panel. A new owner installs new state
 * (`setBox`) and keeps the node, so a repaint never loses focus or an IME
 * composition.
 */
const prose = createProse(input, {
  mode: 'rich',
  label: 'Message',
  onChange: () => syncComposer(),
  onKey: (e) => boxKeys(e),
  sessionName: (pid) => findCard(pid)?.card.name
});

// Attached after the editor it drives, then told its formats by it.
const formatbar = attachFormatbar($('formatbar'), prose);
prose.update({ onFormat: (formats) => formatbar.paint(formats) });

const EMPTY_DOC: ComposeDoc = { type: 'doc', content: [{ type: 'paragraph' }] };

const liveDoc = (): ComposeDoc => prose.snapshot() as ComposeDoc;

/** Whether there is a box at all — a session selected, or a draft up. */
function hasBox(): boolean {
  return chats.active() !== null;
}

/**
 * The folder the file dialog opens in. A card gives the directory its session
 * stands in, not its group's. The two differ once a session moves
 * (`host/session_io.ts` has the measurement).
 *
 * Undefined disables the clip. A session that left the board has no folder,
 * and the host silently drops a post for its dead pid. Accepted cost: a draft
 * promoted on a `reveal` that beat its state push has no group until the next
 * push, so the clip is grey for one push. `chats.thread()` has no answer then
 * either.
 */
function boxCwd(): string | undefined {
  return chats.context(ui.state)?.cwd;
}

/**
 * The workflow the box's next message mentions. A draft's rides its first
 * turn: promotion writes it into `mention`, and the ordinary send carries it.
 * Arming at start lands one turn late, because the host has no prompt to brief
 * over yet.
 */
function boxWorkflow(): string | undefined {
  return chats.compose()?.workflowId;
}

function setBoxWorkflow(id: string | undefined): void {
  const owner = chats.active();
  if (owner) chats.edit(owner, { workflowId: id });
}

/** Whose box this is, as one comparable value — the slot's signature key, and
 *  the owner whose state the editor holds. */
function boxKey(): string {
  return ownerKey(chats.active());
}

const ownerKey = (owner: ReturnType<typeof chats.active>): string =>
  !owner
    ? '-'
    : owner.kind === 'draft'
      ? 'draft:' + owner.cwd
      : `session:${owner.pid}:${owner.startedAt}`;

/**
 * The owner whose state the editor holds. `setBox` installs a fresh state when
 * the active owner is another one, so no Undo reaches across two boxes.
 */
let shownKey = '-';

/**
 * A pick in the composer's box: the chip, set apart by a space, as one Undo
 * step. `mentions.ts` has already cut the run and placed the caret.
 */
function writeMention(mention: Mention): string {
  if (!hasBox()) return '';
  prose.insertChip(mention.kind, mention.expansion);
  return `${mention.expansion} `;
}

// The affordance's own test: no list, no trigger. The host sends none for a
// background session, so there is no second rule here.
attachMentions(prose.selection, {
  opened: () => vscode.postMessage({ type: 'refreshSkills' }),
  skillsChanged: (skills) => prose.update({ skills }),
  sources: () => {
    const context = chats.context(ui.state);
    if (!context) return {};
    const active = chats.active();
    const self = active?.kind === 'session' ? active.pid : undefined;
    return {
      // The board's list, not the session's: the peer a model mention asks
      // for may run another brand, and `context.models` is one brand's.
      models: ui.state.models,
      skills: context.skills ?? [],
      sessions: ui.state.groups.flatMap((g) => g.sessions).filter((card) => card.pid !== self)
    };
  },
  write: writeMention
});

/**
 * The editor's document into the active owner's record, and the send button
 * after it. One path for every edit: typing, a pick, a paste, a chip removed.
 */
export function syncComposer(): void {
  if (startupHolding()) return;
  stashBox();
  input.classList.toggle('empty', showComposeHint(liveDoc()));
  renderSend();
}

/**
 * Write the editor's document into the active owner's record. Call it before
 * anything leaves the box or reads the record: an import changes the editor
 * without an edit. A locked box stashes too, because a file pick can add a chip
 * to it.
 */
export function stashBox(): void {
  const owner = chats.active();
  if (!owner || shownKey !== ownerKey(owner)) return;
  chats.edit(owner, { doc: liveDoc() });
}

/**
 * Show the active owner's record in the box. A new owner, or a record changed
 * under the box (a send cleared it, a refusal restored it, a ticket arrived),
 * gets a fresh state and Undo history. The same owner with the same document
 * installs nothing, so the caret and history survive a repaint. A record with
 * no document is an empty box.
 */
export function setBox(): void {
  if (startupHolding()) return;
  const owner = chats.active();
  const key = ownerKey(owner);
  const compose = chats.compose();
  const doc = compose?.doc;
  const live = liveDoc();
  const same = doc ? sameDoc(doc, live) : blank(live);
  if (key !== shownKey || !same) install(doc);
  shownKey = key;
  syncComposer();
}

/** A fresh editor state holding `doc`, else nothing. A document that does
 *  not fit the schema (malformed) is dropped rather than left behind under
 *  another owner's key. */
function install(doc: ComposeDoc | undefined): void {
  if (doc && prose.restore(doc, { history: 'fresh' })) return;
  prose.restore(EMPTY_DOC, { history: 'fresh' });
}

/**
 * The same box changing its key: a draft promoted onto the session it started.
 * The editor keeps its state, its history and its pool (orchestrator decision,
 * `TASK_done_prose_input.md`). Only a change to another box resets.
 */
export function rekeyBox(from: string, to: string): void {
  if (shownKey === from) shownKey = to;
}

export { ownerKey };

/**
 * The editor no longer holds any owner's state: the next `setBox` installs a
 * fresh one even for the owner it held. For a leave that prunes the record's
 * pool (`ChatState.deactivate`) with no other owner shown after it.
 */
export function releaseBox(): void {
  shownKey = '-';
}

/** Whether the box takes typing. Read-only is the editor's; the attribute is
 *  what the stylesheet and a reader of `#input` see. */
export function boxLocked(): boolean {
  return input.getAttribute('aria-disabled') === 'true';
}

export function lockBox(locked: boolean, placeholder?: string): void {
  if (startupHolding()) return;
  input.setAttribute('aria-disabled', String(locked));
  if (placeholder !== undefined) {
    input.setAttribute('placeholder', placeholder);
    const label = document.querySelector('.hintlabel');
    if (label) label.textContent = placeholder;
  }
  prose.update({
    readOnly: locked,
    ...(placeholder === undefined ? {} : { label: placeholder })
  });
}

export function focusBox(): void {
  if (!boxLocked()) prose.focus();
}

/**
 * The clip asks the host for its file dialog. A webview `<input type="file">`
 * gives bytes and a bare filename, and the session needs the path. So the host
 * picks (`showOpenDialog`), and this end writes down the answer.
 */
$('fattach').onclick = () => {
  const owner = chats.active();
  const cwd = boxCwd();
  if (!owner || cwd === undefined || boxLocked()) return;
  const pick = chats.beginFilePick(owner);
  if (!pick) return;
  vscode.postMessage({ type: 'pickFiles', cwd, operationId: pick.operationId });
};

/**
 * The model pill beside the clip. It uses the card's `modelMenuBody`, so the
 * list, the ticked row and the cold-cache sentence cannot drift. Built once and
 * relabelled, never rebuilt, for the lost click `slotSignature` describes.
 */
const {
  wrap: modelWrap,
  button: modelTrigger,
  label: modelLabel,
  caret: modelCaret
} = dropdownTrigger('', 'model');
// The context is read when the menu opens. The pill outlives every session it
// labels, so a captured one would post a pick to an old selection.
modelWrap.append(
  opensMenu(modelWrap, modelTrigger, 'start', (m) => {
    const ctx = chats.context(ui.state);
    if (ctx) modelMenuBody(m, ctx, () => renderModel());
  })
);

const {
  wrap: effortWrap,
  button: effortTrigger,
  label: effortLabel
} = dropdownTrigger('', 'effort');
effortWrap.append(
  opensMenu(effortWrap, effortTrigger, 'start', (m) => {
    const ctx = chats.context(ui.state);
    if (ctx) effortMenuBody(m, ctx, () => renderModel());
  })
);

/**
 * What the pill says, and whether it shows. A session on a pipe some window
 * holds (`owned`) gets the pill. A session with no model-change verb gets it
 * disabled. An unreachable session gets none.
 *
 * The label is the CLI's name for the model, else the stated value. Two
 * versions of one model are two menu rows, so a value with no match shows as
 * itself, never as a guessed name.
 *
 * The pill shows the next message's target, and a pick changes it at once. The
 * card shows what the session last ran on, so the two can disagree until a turn
 * runs. The tip says when the pick takes effect.
 */
function renderModel(): void {
  // Hold still while a menu is open: the pick is in progress.
  if (heldOpen(modelWrap) || heldOpen(effortWrap)) return;
  const ctx = chats.context(ui.state);
  if (!ctx) {
    modelWrap.remove();
    effortWrap.remove();
    return;
  }
  const named = (value: string | undefined): string =>
    ctx.models.find((m) => m.value === value)?.name || value || '';
  // A value two rows share is one model at two windows, so the pill names the
  // window, as the gear's `Opus 5 (200k)` does. Both branches use this, so the
  // label holds across a draft's first send.
  const withWindow = (name: string): string =>
    ctx.models.filter((m) => m.value === ctx.model).length > 1 && ctx.window !== undefined
      ? `${name} (${ctxLabel(ctx.window)})`
      : name;
  if (!ctx.bound && ctx.identity.kind === 'draft') {
    modelTrigger.disabled = false;
    if (!modelCaret.isConnected) modelTrigger.append(modelCaret);
    modelTrigger.setAttribute('aria-expanded', 'false');
    modelTrigger.setAttribute('aria-haspopup', 'menu');
    const pick = ctx.model;
    const window = ctx.window;
    modelLabel.textContent = withWindow(named(pick) || 'default');
    modelTrigger.dataset.tip = 'What this session will start on';
    if (!modelWrap.isConnected) $('fattach').after(modelWrap);
    const effortModel = resolveModel(ctx.models, undefined, pick, window);
    const effort = ctx.effort;
    if (effortModel?.efforts?.length) {
      effortLabel.textContent = effort ?? 'effort';
      effortTrigger.dataset.tip = 'How hard this session will reason';
      if (!effortWrap.isConnected) $('ctools').append(effortWrap);
    } else {
      effortWrap.remove();
    }
    return;
  }
  const mine = ctx.thread;
  if (!mine || !ctx.owned) {
    modelWrap.remove();
    effortWrap.remove();
    return;
  }
  const value = ctx.model;
  modelLabel.textContent = withWindow(named(value));
  modelTrigger.disabled = !ctx.canModel;
  modelTrigger.dataset.tip = ctx.canModel
    ? 'Model for the next message'
    : 'This model is fixed for the conversation';
  if (ctx.canModel) {
    if (!modelCaret.isConnected) modelTrigger.append(modelCaret);
    modelTrigger.setAttribute('aria-expanded', 'false');
    modelTrigger.setAttribute('aria-haspopup', 'menu');
  } else {
    modelCaret.remove();
    modelTrigger.removeAttribute('aria-expanded');
    modelTrigger.removeAttribute('aria-haspopup');
  }
  // `append` of an attached child removes and reinserts it, and removing the
  // focused node sends focus to the body. So insert only when detached.
  if (!modelWrap.isConnected) $('fattach').after(modelWrap);
  const effortModel = resolveModel(ctx.models, mine.model, ctx.model, ctx.window);
  const effort = ctx.effort;
  if (effortModel?.efforts?.length) {
    effortLabel.textContent = effort ?? 'effort';
    effortTrigger.dataset.tip = 'Effort for the next message';
    if (!effortWrap.isConnected) $('ctools').append(effortWrap);
  } else {
    effortWrap.remove();
  }
}

/**
 * The dialog's picks, as one file chip per path. They go to the box that asked.
 * The dialog is modal to the host, not the panel, so the reader may select
 * another card while it is open. A box not on screen gets the chips appended to
 * its record. A path the box already holds is skipped.
 */
export function takePickedFiles(msg: PickedFilesMessage): void {
  const owner = chats.settleFilePick(msg.operationId);
  if (!owner || !msg.paths.length) return;
  const compose = chats.composeFor(owner);
  if (!compose) return;
  // The box on screen takes the chips even when locked: a push can lock it while
  // the host's dialog is up. Its record follows on the stash.
  const active = chats.isActive(owner) && shownKey === ownerKey(owner);
  const named = filePaths(active ? liveDoc() : compose.doc);
  const paths = [...new Set(msg.paths)].filter((path) => !named.has(path));
  if (active) {
    for (const path of paths) {
      prose.insertChip('file', path);
    }
    focusBox();
    return;
  }
  if (!paths.length) return;
  const content = paths.flatMap((path) => [
    {
      type: 'chip',
      attrs: { kind: 'file', expansion: path, attachmentId: null }
    },
    { type: 'text', text: ' ' }
  ]);
  chats.append(owner, { type: 'doc', content: [{ type: 'paragraph', content }] });
}

/** The paths a document's file chips name. */
function filePaths(doc: ComposeDoc | undefined): Set<string> {
  const paths = new Set<string>();
  const walk = (node: ComposeDoc['content'][number]): void => {
    if (node.type === 'chip' && node.attrs?.kind === 'file') {
      const path = node.attrs.expansion;
      if (typeof path === 'string') paths.add(path);
    }
    node.content?.forEach(walk);
  };
  doc?.content.forEach(walk);
  return paths;
}

/**
 * The live run whose × was pressed and not yet answered. It must survive the
 * 3s push between question and answer. Keyed by session incarnation, so a
 * switched session or a recycled pid never inherits the confirm. One at a
 * time, like `bottom_drawer.ts`'s `say`: there is one live chip.
 */
let confirming: { pid: number; startedAt: number } | undefined;

function isConfirming(pid: number, startedAt: number): boolean {
  return confirming?.pid === pid && sameSessionStart(confirming.startedAt, startedAt);
}

/** Put the question away — on an answer, and on anything that moves the slot
 *  out from under it (a new selection, incarnation, or run). */
function stopAsking(): void {
  confirming = undefined;
}

/**
 * The workflow slot (`#wattach`) holds one of three: Attach, an armed chip, or
 * a live chip. Armed and live share `.wflow` and differ by tint, lead and
 * trail. Live is a run on the selected session. It hides Attach, because a
 * second mention would replace a run an agent is part-way through.
 *
 * A finished run keeps the slot until its × clears it. Attach beside it would
 * show two workflow pills with nothing saying which the next Enter means, and
 * the second would overwrite the first's progress file
 * (`PRD_shipped_workflow_progress.md` P5).
 *
 * Armed is a mention on the next send (PRD §14, Q12), not a mode. The send
 * clears it, and the host learns of it from that send.
 *
 * The paint is `mentionSlot`. A workflow alone is a message, so the send button
 * must follow every paint, and `mentionSlot` returns from five places.
 */
export function renderMention(): void {
  if (startupHolding()) return;
  mentionSlot();
  renderSend();
}

/**
 * Everything the slot draws, as one string. `paintIfChanged` repaints only
 * when it changes.
 *
 * The host pushes state every 3s. A control rebuilt between mousedown and
 * mouseup gets no click, because the pressed node is detached. Rebuilt on every
 * push, each control here lost about one press in a handful.
 *
 * A signature, not a keyed morph: morphdom keeps a node's old `.onclick`, and
 * every control here is a direct closure. `question.ts` makes the same choice.
 *
 * So a kept node's handler reads live state when it fires. What is drawn goes
 * in the signature. What a handler needs, it reads at fire time.
 *
 * Left out on purpose: the drawer's open flag, because `syncChipCaret` writes
 * the caret after every `render`, and the picker's menu, which `heldOpen`
 * holds.
 */
function slotSignature(ownedHere: boolean, live: LiveRun): string {
  const armed = boxWorkflow();
  const owner = chats.active();
  const thread = chats.thread();
  return [
    boxKey(),
    ownedHere ? 'own' : '-',
    // The chip's mode, not `status`: `liveTone` folds busy and unknown into one
    // "Following", and `status` changes more often than any other thread field.
    live ? `${live.label}/${live.step?.label ?? ''}/${liveTone(live, thread?.status).mode}` : '-',
    // {@link stopped}'s answer. Without it, a run that goes idle mid-step keeps
    // its busy signature, and Retry never draws.
    live && stopped(live, thread?.status) ? 'stop' : '-',
    // The × question. Without it, the repaint that draws the confirm is skipped.
    thread && isConfirming(thread.pid, thread.startedAt) ? 'ask' : '-',
    // The fold belongs to this compose owner, so another chat with the same
    // workflow id cannot inherit it.
    armed === undefined
      ? '-'
      : `${armed}/${owner && chats.workflowFolded(owner, armed) ? 'open' : 'shut'}`,
    fingerprint(ui.state.workflows ?? [])
  ].join('|');
}

/** The one live run a thread can carry, named once — three files spell it. */
type LiveRun = ThreadView['workflow'];

/**
 * The authored workflows as their two painters see them: ids, names, order and
 * step labels, never prompts. Step labels are in it so a fold renames with its
 * workflow.
 */
export function fingerprint(workflows: readonly WorkflowView[]): string {
  return workflows
    .map((w) => `${w.id}:${w.label}:${w.steps.map((s) => `${s.id}~${s.label}`).join('>')}`)
    .join(',');
}

function mentionSlot(): void {
  const root = $('wattach');
  const workflows = ui.state.workflows ?? [];

  // Drop a mention whose workflow is gone, or every send is refused for a cause
  // nobody can see. Before both returns below: `readWorkflows` answers an empty
  // list to a failed `readdir`, so one bad poll loses every workflow. A mention
  // that outlives its chip refuses every send until the panel reloads. This
  // runs above `heldOpen` too, which protects a trigger, not a fact.
  const armedNow = boxWorkflow();
  if (armedNow !== undefined && !workflows.some((w) => w.id === armedNow)) {
    setBoxWorkflow(undefined);
  }

  // Its menu is open: a rebuild would detach the trigger its handler runs on.
  if (heldOpen(root)) return;

  // Attach and the chip only for sessions this panel drives. A mention on a
  // thread this window cannot reach would be invisible, unremovable and unsent.
  // An empty machine still shows New workflow… (surfaces PRD Phase A).
  const thread = chats.thread();
  const ctx = chats.context(ui.state);
  const unbound = ctx !== undefined && !ctx.bound;
  const pid = ui.selected;
  const ownedHere = unbound || panelDrives(pid);

  // Any run on the wire takes the slot (`renderMention`). The hidden mention goes
  // too: left under the live chip, it re-arms on the next Enter and replaces the
  // run. Before the signature, so the dropped mention is not in it. Behind
  // `ownedHere`, so a slot that draws nothing for a session leaves its map alone.
  const status = thread?.status;
  // No run can be live on a draft: there is no session for one to be running on.
  const live = !unbound && pid !== null && thread?.pid === pid ? thread.workflow : undefined;
  const holds = live !== undefined;
  if (pid !== null && ownedHere && holds) {
    const owner = chats.active();
    if (owner) chats.edit(owner, { workflowId: undefined });
  }

  // A run that stopped between pushes takes its question with it. A confirm left
  // standing would answer for the next run in this slot.
  if (
    confirming !== undefined &&
    (!thread || !live || !isConfirming(thread.pid, thread.startedAt))
  ) {
    stopAsking();
  }

  const sig = slotSignature(ownedHere, live);

  if (!ownedHere || ctx === undefined) {
    // One constant rather than a signature: every empty slot is the same empty
    // slot, whichever of the two reasons emptied it.
    paintIfChanged(root, '-', () => root.replaceChildren());
    render();
    return;
  }

  // `holds` is only ever true for a session — `live` is `undefined` for a
  // draft — so the pid is there whenever this branch is.
  if (holds && pid !== null && thread) {
    paintIfChanged(root, sig, () =>
      root.replaceChildren(...liveSlot(live, status, pid, thread.startedAt))
    );
    // After the chip, so the caret syncs to a chip in the document, including
    // one this push did not repaint.
    render();
    return;
  }
  // No run reaches here (`holds` took them all), so this call shuts the rail.
  render();

  paintIfChanged(root, sig, () => {
    const picked = workflows.find((w) => w.id === boxWorkflow());

    // A list, not the sheet: a pick happens mid-sentence, and the sheet is a
    // board away from the caret (Q3, `PRD_shipped_workflow_sheet.md`). Order,
    // pins and row actions stay on the sheet.
    const trigger = picker({
      label: 'Apply workflow…',
      tip: 'Choose a workflow to mention on the next message',
      options: workflows.map((w) => ({
        id: w.id,
        label: w.label,
        sub: `${w.steps.length} step${w.steps.length === 1 ? '' : 's'}`
      })),
      // Never the pick: the pill is the door and the chip is what was chosen, so
      // a pill that renamed itself would say the same thing twice.
      value: [],
      // The only New an empty machine can reach without crossing the board: the
      // sheet refuses to open with nothing in it (S8).
      footer: { label: 'New workflow…', onClick: () => openCreate() },
      onChange: ({ value }) => {
        const next = value[0];
        if (next === undefined) return;
        setBoxWorkflow(next);
        renderMention();
      }
    });

    if (!picked) {
      root.replaceChildren(trigger);
      return;
    }

    // Armed alone — Attach is the empty-slot control, not a sibling of the chip.
    const chip = el('div', 'wflow armed');
    const owner = chats.active();
    const open = owner ? chats.workflowFolded(owner, picked.id) : false;
    const lead = el('span', 'lead');
    const peek = el('button', 'peek', open ? '▾' : '▸');
    peek.dataset.tip = open ? 'Hide the steps' : 'Show the steps';
    peek.setAttribute('aria-label', open ? 'Hide the steps' : 'Show the steps');
    peek.setAttribute('aria-expanded', String(open));
    peek.onclick = () => {
      if (owner) chats.setWorkflowFold(owner, picked.id, !open);
      renderMention();
    };
    lead.append(peek);
    const edit = el('button', 'wedit', 'Edit');
    edit.dataset.tip = 'Edit this workflow';
    // Looked up when pressed (`slotSignature`). Prompts are not in the
    // signature, so a captured view could open stale prompts and save them over
    // an edit.
    edit.onclick = () => {
      const now = (ui.state.workflows ?? []).find((w) => w.id === picked.id);
      if (now) openEdit(now);
    };
    const drop = el('button', 'drop', '×');
    drop.dataset.tip = 'Remove';
    drop.setAttribute('aria-label', 'Remove this workflow');
    drop.onclick = () => {
      setBoxWorkflow(undefined);
      renderMention();
    };
    chip.append(
      lead,
      el('span', 'nm', picked.label),
      el('span', 'meta', `${picked.steps.length} step${picked.steps.length === 1 ? '' : 's'}`),
      edit,
      drop
    );

    root.replaceChildren(chip);
    // A6: you approve a process, not a filename. Names in order, and nothing else
    // — what a step actually runs never crosses the wire.
    if (open) {
      const list = el('ol', 'wsteps');
      list.append(...picked.steps.map((s) => el('li', 'wstep', s.label)));
      root.append(list);
    }
  });
}

/**
 * The live chip's mode and leading verb. The chip and `slotSignature` share it,
 * so they agree. `waiting` outranks the run. A run that has {@link stopped}
 * reads Paused.
 */
function liveTone(
  workflow: NonNullable<LiveRun>,
  status: SessionStatusView | undefined
): { mode: 'running' | 'paused' | 'waiting' | 'done'; verb: string } {
  if (status === 'waiting') return { mode: 'waiting', verb: 'Waiting' };
  if (workflow.phase === 'done') return { mode: 'done', verb: 'Done' };
  if (stopped(workflow, status)) return { mode: 'paused', verb: 'Paused' };
  return { mode: 'running', verb: 'Following' };
}

/**
 * Whether the run is still work rather than a record of work. It reads the
 * run's phase, not the session's status: a session goes idle between steps.
 *
 * `running` includes a seeded file nobody has touched yet. A second mention
 * does the most damage there: `stageForSend` would overwrite the file the agent
 * is about to write.
 */
export function working(workflow: NonNullable<LiveRun>): boolean {
  return workflow.phase === 'running';
}

/**
 * The chip and its ×, or the confirm in their place once × is pressed. Both
 * shapes are drawn here, so the confirm always takes the chip's place.
 *
 * A list, because the × is a sibling: `liveChip` is a `<button>`, and the HTML
 * parser breaks a button out of a button, splitting the chip.
 *
 * A stopped run also gets Retry / Continue. It and × are the two answers, so
 * neither is a default.
 */
function liveSlot(
  workflow: NonNullable<LiveRun>,
  status: SessionStatusView | undefined,
  pid: number,
  startedAt: number
): HTMLElement[] {
  if (isConfirming(pid, startedAt)) {
    return confirmCancel(workflow, pid, startedAt);
  }
  // A done run's × asks nothing. The confirm guards a × that reaches the
  // session: it interrupts a working run or abandons a failed one's steps. A
  // done run's × only clears paint, and it is on the path to every next workflow.
  const done = workflow.phase === 'done';
  const stop = el('button', 'drop wcancel', '×') as HTMLButtonElement;
  stop.type = 'button';
  const verb = working(workflow) ? 'Cancel' : 'Dismiss';
  stop.dataset.tip = working(workflow) ? 'Stop this workflow' : 'Clear this finished workflow';
  stop.setAttribute('aria-label', `${verb} ${workflow.label}`);
  stop.onclick = () => {
    if (done) {
      vscode.postMessage({ type: 'cancelWorkflow', pid, startedAt });
    } else {
      confirming = { pid, startedAt };
    }
    renderMention();
  };
  const slot: HTMLElement[] = [liveChip(workflow, status)];
  if (stopped(workflow, status)) {
    slot.push(retry(workflow, pid, startedAt));
  }
  slot.push(stop);
  return slot;
}

/**
 * Whether the run stopped short: the question Retry answers.
 *
 * `failed` is the pre-CLI shape, which an agent wrote by hand. It reads Paused
 * like the rest: from outside, a failed, a stuck and a questioning agent look
 * alike. `squadron-step` has no failure verb. An unfinished step stays
 * `in_progress`, so `phase` reads `running` for an abandoned step and for a
 * worked one alike.
 *
 * The session's status tells them apart. Busy is mid-step. Idle with steps left
 * has stopped. `ui/reading.ts` `stepList` gates `completion` on `idle` for the
 * same reason. `waiting` is not idle: a session at a permission prompt is
 * blocked on the reader, and Retry would talk over its dialog.
 *
 * `retryWorkflow` applies this rule on the host. Change both or neither.
 */
function stopped(workflow: NonNullable<LiveRun>, status: SessionStatusView | undefined): boolean {
  if (status !== 'idle') return false;
  if (workflow.phase === 'failed') return true;
  // A step must be in hand: a run whose steps are all pending is one armed and
  // not yet taken up.
  return workflow.phase === 'running' && workflow.step?.tone === 'working';
}

/**
 * The other answer to a stopped run: ask the session about the step it left.
 * No confirm: a stray press only puts a question on the pipe, and the reader
 * watches the chip move as the session answers.
 *
 * No local "retrying…" state. The chip's colour comes from the progress file,
 * so it changes only when the session's next step moves the cursor.
 */
function retry(workflow: NonNullable<LiveRun>, pid: number, startedAt: number): HTMLElement {
  const button = el('button', 'wretry', 'Retry / Continue') as HTMLButtonElement;
  button.type = 'button';
  button.dataset.tip = 'Ask this session where it stands on this step';
  button.setAttribute('aria-label', `Retry or continue ${workflow.step?.label ?? workflow.label}`);
  button.onclick = () => {
    vscode.postMessage({ type: 'retryWorkflow', pid, startedAt });
  };
  return button;
}

/**
 * The × question, in the chip's place. Same shape as `bottom_drawer.ts`'s delete
 * confirm.
 *
 * Asked of a working run and a failed one, never a done one (`liveSlot`).
 * Working includes a queued arming message: `queued` counts every held message,
 * so the panel cannot tell it from one the agent holds (`cancelOrphanedArmed`).
 * Dismissing a failed run abandons its remaining steps. A run with a step names
 * it, because that is what makes a reader stop.
 *
 * Both buttons are new on every paint (`slotSignature` gates a full replace),
 * so no handler is inherited.
 */
function confirmCancel(
  workflow: NonNullable<LiveRun>,
  pid: number,
  startedAt: number
): HTMLElement[] {
  const step = workflow.step;
  const asking = el('span', 'wask');
  asking.append(
    el('span', 'q', working(workflow) ? 'Cancel' : 'Dismiss'),
    el('span', 'nm', workflow.label)
  );
  if (step) {
    asking.append(el('span', `sname ${step.tone}`, step.label));
  }
  asking.append(el('span', 'q', '?'));

  const yes = el('button', 'act fbtn danger', working(workflow) ? 'Cancel run' : 'Dismiss');
  (yes as HTMLButtonElement).type = 'button';
  yes.setAttribute('aria-label', `Stop ${workflow.label}`);
  yes.onclick = () => {
    stopAsking();
    vscode.postMessage({ type: 'cancelWorkflow', pid, startedAt });
    renderMention();
  };

  const no = el('button', 'act fbtn', 'Keep');
  (no as HTMLButtonElement).type = 'button';
  no.onclick = () => {
    stopAsking();
    renderMention();
  };

  return [asking, yes, no];
}

/** Live provenance chip — same `.wflow` silhouette as armed; status is the mode.
 *  Click / Enter / Space toggles the observe drawer (placement E over the board). */
function liveChip(
  workflow: NonNullable<LiveRun>,
  status: SessionStatusView | undefined
): HTMLElement {
  const step = workflow.step;
  const { mode, verb } = liveTone(workflow, status);

  const chip = el('button', `wflow live ${mode}${isOpen() ? ' open' : ''}`);
  (chip as HTMLButtonElement).type = 'button';
  chip.setAttribute('aria-expanded', String(isOpen()));
  chip.setAttribute('aria-controls', 'workflowoverviewdrawer');
  chip.dataset.tip = isOpen() ? 'Hide workflow steps' : 'Show workflow steps';
  const lead = el('span', 'lead');
  lead.append(el('span', 'gem'));
  chip.append(
    el('span', 'caret'),
    lead,
    el('span', 'verb', verb),
    el('span', 'nm', workflow.label)
  );
  if (step) {
    chip.append(el('span', `sname ${step.tone}`, step.label));
  }
  chip.onclick = () => toggleDrawer();
  return chip;
}

/**
 * A clipboard image becomes a chip, its bytes pooled under the chip's id. The
 * bytes ride the pipe as their own blocks. The chip is only the reference.
 *
 * Capture phase on the host: ProseMirror skips a paste whose default is
 * already prevented. A paste with no image is the editor's.
 */
input.addEventListener(
  'paste',
  (e: ClipboardEvent) => {
    // Through the context, as `renderSend` reads it. A draft has no thread, and
    // opening one clears `selected` before the `select pid: 0` refresh clears
    // `thread`. A gate on the thread would drop a paste into a draft opened from
    // a remote card or from a brand that takes no images.
    const ctx = chats.context(ui.state);
    if (ctx && !ctx.canAttach) return;
    if (!hasBox() || boxLocked()) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const was = boxKey();
    for (const file of files) void attach(was, file);
  },
  true
);

async function attach(box: string, file: File): Promise<void> {
  if (!PASTEABLE.includes(file.type)) {
    // Refused in the line that already explains why a send did not go.
    $('blocked').textContent =
      (chats.context(ui.state)?.bound ? 'This session takes' : 'Sessions take') +
      ` PNG, JPEG, GIF and WebP images — not ${file.type}.`;
    return;
  }
  if (file.size > MAX_PASTE_BYTES) {
    $('blocked').textContent =
      `That image is ${Math.round(file.size / 1e6)}MB; the limit here is 10MB.`;
    return;
  }
  // `FileReader` rather than `arrayBuffer()` plus `btoa`: it hands back the
  // data URL already encoded, and it is what the jsdom the scenarios run under
  // implements.
  const dataUrl = await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
  // Only into the box still open. The decode is async, and another box must not
  // get an image nobody pasted into it.
  const owner = chats.active();
  if (!owner || boxKey() !== box || shownKey !== box) return;
  if (!dataUrl) {
    $('blocked').textContent = 'That image could not be read.';
    return;
  }
  const image = { name: file.name || 'pasted image', mediaType: file.type, dataUrl };
  const id = chats.attach(owner, { kind: 'image', image });
  // Numbered by the editor in the same dispatch (`prose.ts`, `numbering`).
  prose.insertChip('image', '[Image #1]', id);
}

/**
 * The composer's keys, ahead of the editor's keymap (`ProseOptions.onKey`).
 * Enter sends. Shift+Enter is the editor's Enter: a line break, a list item, a
 * code newline. Deciding here stops the editor from running Enter and then
 * bubbling it to a send. An open `@` menu takes Enter first (`mentions.ts`).
 */
function boxKeys(e: KeyboardEvent): boolean {
  // IME keys never arrive (`prose.ts`, `imeKey`), so an IME's Enter commits 你好
  // rather than sending. `hasBox()`, not a pid: a draft's Enter starts the
  // session with nothing selected.
  if (e.key !== 'Enter' || e.shiftKey || boxLocked() || !hasBox()) return false;
  e.preventDefault();
  submit();
  return true;
}

/**
 * Escape ends the turn, as in the terminal, wherever focus is: opening a dock
 * focuses nothing, and a click on a turn takes focus from the composer.
 *
 * It is the last owner. On the window, it hears the key after every document
 * listener. A surface that shuts on Escape (a sheet, the drawer, a menu, the ask
 * layer) calls `preventDefault` or stops it, so one press never both dismisses
 * and interrupts. The tip does neither: hiding it is passive, and consuming
 * Escape would kill it over the dock's Interrupt button.
 */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || !ui.selected || lightboxOpen()) return;
  // The board editor covers the board, and its Escape is Back (editor.ts).
  if (editing()) return;
  if (imeKey(e)) return;
  const at = e.target;
  // In another box the reader is typing, not reaching for the session. The ask
  // layer answers its own dialog. The composer is an editor inside
  // `#input`, so its key arrives from a descendant.
  const ours = at instanceof Node && input.contains(at);
  if ((typingIn(at) && !ours) || (at instanceof Element && at.closest('#ask'))) return;
  // Nothing to end reads as nothing to do — the draft in the box is the
  // reader's, and Escape is not going to be what empties it.
  const t = chats.thread();
  if (!t || t.pid !== ui.selected || !endable(t)) return;
  e.preventDefault();
  vscode.postMessage({ type: 'interrupt', pid: t.pid, startedAt: t.startedAt });
});

/**
 * What a send would carry now, or `null`. One capture of the document: the wire
 * with image chips numbered in order, its images, and the attachments a refusal
 * restores. A wire with no text, image or workflow sends nothing, even when the
 * document is not empty: `capture` drops an image chip whose bytes were never
 * pooled.
 */
function captureMessage(compose: ComposeState, liveRun: boolean): SendInput | null {
  const workflowId = liveRun ? undefined : compose.workflowId;
  const doc = liveDoc();
  if (!eligibleCompose({ ...compose, doc, workflowId }, liveRun)) return null;
  const { wire, images, attachments } = capture(doc, compose.pool ?? {});
  const delivered = deliveryOf(wire).trimEnd();
  if (!delivered.trim() && !images.length && workflowId === undefined) return null;
  return {
    delivered,
    images,
    ...(workflowId === undefined ? {} : { workflowId }),
    doc,
    attachments,
    at: Date.now()
  };
}

/** The active owner's compose, with the editor's document as it stands. */
function liveCompose(compose: Readonly<ComposeState>): ComposeState {
  return { ...compose, doc: liveDoc() };
}

/**
 * The send button: its accessible name, and whether it can be pressed. The
 * name matches the hint: Start, Send, Queue or Starting. The button holds the
 * arrow, or a spinner while a start is in flight. Disabled is `canSubmit`'s
 * answer, the same check `submit` makes. One enabled press posts nothing on
 * purpose: the cold-cache confirmation.
 */
export function renderSend(): void {
  if (startupHolding()) return;
  const send = $('send') as HTMLButtonElement;
  const ctx = chats.context(ui.state);
  const mine = ctx?.thread;
  const queues = !!mine && ctx?.canSend === true && isMidTurn(mine.status);
  // One label for the accessible name and the hint. The button holds an icon,
  // so reading its text would name neither.
  const label = ctx?.starting
    ? 'Starting'
    : ctx && !ctx.bound
      ? 'Start'
      : queues
        ? 'Queue'
        : 'Send';
  send.setAttribute('aria-label', label);
  // A start in flight says so where the reader just pressed: the spinner
  // replaces the arrow, and the box is disabled, so the hint is hidden. This
  // runs on every keystroke and push, so the glyph is swapped only when it
  // changes: a press on a replaced node never becomes a click.
  if (ctx?.starting) {
    if (!send.querySelector('.spinner')) send.replaceChildren(el('div', 'spinner'));
  } else if (!send.querySelector('svg')) send.innerHTML = icon('arrowUp', 15);
  const ghost = document.querySelector<HTMLElement>('.hintkeys span');
  if (ghost) ghost.textContent = ` ${label.toLowerCase()} · ⇧↵ newline`;
  send.classList.toggle('queues', queues);
  document.querySelector<HTMLElement>('.shell')?.classList.toggle('queues', queues);
  const liveRun = !!mine?.workflow;
  send.disabled = !ctx
    ? true
    : !canSubmit(liveCompose(ctx.compose), {
        held: ctx.held,
        bound: ctx.bound,
        liveRun,
        starting: ctx.starting,
        canSend: ctx.canSend
      });
  ($('fattach') as HTMLButtonElement).disabled = boxCwd() === undefined || ctx?.canSend === false;
  // Which phrases form a chip is the box's thread's.
  const skills = ctx?.skills ?? [];
  if (skills.join('\n') !== shownSkills) {
    shownSkills = skills.join('\n');
    prose.update({ skills });
  }
  renderModel();
  // After renderModel. A mode placed before it sits ahead of an effort pill
  // this paint attaches, because that pill is appended only while detached.
  placeMode();
}

/**
 * The permission mode, after the model and, when the model has one, after
 * effort. A draft has no thread, so the mode the last session left is cleared.
 * Kept in place across paints, as Send's glyph is: a replaced node drops the
 * tip hovering it.
 */
function placeMode(): void {
  const shown = document.querySelector<HTMLElement>('#ctools .mode');
  const mode = chats.thread()?.mode;
  if (!mode) {
    shown?.remove();
    return;
  }
  const node = shown ?? el('span');
  node.className = mode.bypass ? 'mode bypass' : 'mode';
  const glyph = mode.holds ? '⏸' : '⏵⏵';
  if (node.textContent !== glyph + mode.label) {
    node.replaceChildren(el('span', 'g', glyph), el('span', null, mode.label));
  }
  node.dataset.tip = `permission mode: ${mode.label} · as its transcript last stated it.`;
  const anchor = effortWrap.isConnected
    ? effortWrap
    : modelWrap.isConnected
      ? modelWrap
      : $('fattach');
  if (anchor.nextElementSibling !== node) anchor.after(node);
}

/** The skills the editor forms chips from, as last handed to it. */
let shownSkills = '';

/**
 * Every chip's label drawn again: a session chip names its card, and a push
 * may have renamed it. `main.ts` calls this on every state push.
 */
export function relabelBox(): void {
  prose.update({});
}

/**
 * The box is exactly `/rename` or `/rename <title>`, with the title's
 * whitespace folded to one line. Anything else that starts with `/` is a
 * message. An image or a workflow mention keeps it a message too — the caller
 * checks those, because they are not in the text.
 */
function typedRename(
  text: string
): { kind: 'bare' } | { kind: 'titled'; title: string } | undefined {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '/rename') return { kind: 'bare' };
  if (!line.startsWith('/rename ')) return undefined;
  const title = line.slice('/rename '.length).trim();
  return title ? { kind: 'titled', title } : undefined;
}

/**
 * The send, from Enter or the button. Every check on whether a send happens is
 * here, so the two cannot drift: a click that gets past a disabled button is
 * refused on the same lines as a keystroke.
 */
function submit(): void {
  const ctx = chats.context(ui.state);
  const liveRun = !!ctx?.thread?.workflow;
  if (
    !ctx ||
    !canSubmit(liveCompose(ctx.compose), {
      held: ctx.held,
      bound: ctx.bound,
      liveRun,
      starting: ctx.starting,
      canSend: ctx.canSend
    })
  )
    return;
  const owner = ctx.identity;
  stashBox();
  const compose = chats.composeFor(owner);
  if (!compose) return;
  // Before the send is captured. The host's send path also carries a peer's
  // `squadron-send`, and that `/rename` must stay a message.
  const doc = liveDoc();
  const typed = typedRename(prose.value());
  const mentioned = !liveRun && compose.workflowId !== undefined;
  if (typed && !hasChip(doc) && !mentioned) {
    if (!ctx.bound) {
      // Settled 2026-10-05: as a first message this renames only on Claude's
      // pipe. Grok and Codex call the model, so a draft refuses it on every brand.
      $('blocked').textContent = 'Rename it after the session starts.';
      return;
    }
    if (owner.kind !== 'session') return;
    if (typed.kind === 'bare') openRename();
    else submitRename(owner.pid, owner.startedAt, typed.title);
    chats.edit(owner, { doc: undefined });
    setBox();
    return;
  }
  const snapshot = captureMessage(compose, liveRun);
  if (!snapshot) return;
  if (!ctx.bound) {
    if (ctx.held) return;
    chats.holdSubmit(owner, snapshot);
    const draft = chats.draftFor(owner.kind === 'draft' ? owner.cwd : '');
    if (!draft) return;
    startDraft(draft, snapshot);
    renderActive();
    return;
  }
  const pid = owner.kind === 'session' ? owner.pid : null;
  if (pid === null) return;
  const t = ctx.thread;
  if (t && t.pid === pid && cacheGone(t) && !chats.session(pid)?.recache) {
    chats.setRecache(pid, true);
    $('blocked').textContent = CACHE_NOTE;
    renderSend();
    return;
  }
  chats.setRecache(pid, false);
  post(pid, snapshot);
}

/** Whether a document holds a chip: an attachment or a mention keeps a typed
 *  `/rename` a message. */
function hasChip(doc: ComposeDoc): boolean {
  const walk = (node: ComposeDoc['content'][number]): boolean =>
    node.type === 'chip' || (node.content ?? []).some(walk);
  return doc.content.some(walk);
}

/**
 * Put one send on the wire and clear what it spent. A promoted draft's first
 * turn uses this too, with no box to read: it posts for that pid whether or not
 * the reader still has it open. Whether to send (the cold-cache confirmation, a
 * draft's start) stays with the caller.
 */
function post(pid: number, payload: SendInput): void {
  const session = chats.session(pid);
  if (!session) return;
  const sent = chats.beginSend(pid, payload);
  if (!sent) return;
  const target = sent.target;
  vscode.postMessage({
    type: 'send',
    pid,
    startedAt: session.identity.startedAt,
    operationId: sent.operationId,
    text: payload.delivered,
    ...(payload.images.length ? { images: payload.images } : {}),
    ...(payload.workflowId === undefined ? {} : { workflowId: payload.workflowId }),
    ...(target === undefined ? {} : { target })
  });
  chats.clearRefusal(pid);
  if (ui.selected === pid) setBox();
  renderMention();
  renderActive();
}

/** Bound first send: the held snapshot, never live compose. */
export function sendHeld(pid: number, payload: SendInput): void {
  const session = chats.session(pid);
  const mine = session?.thread;
  if (mine && !mine.canSend) {
    chats.refuseHeld(pid, 'This session cannot take a message.');
    if (ui.selected === pid) {
      $('blocked').textContent = 'This session cannot take a message.';
      renderMention();
      renderActive();
    }
    return;
  }
  post(pid, payload);
}

/** Retry the visible held snapshot without recapturing live compose. */
export function retryHeld(): void {
  const ctx = chats.context(ui.state);
  const snapshot = ctx?.held;
  if (!ctx || !snapshot || ctx.starting) return;
  if (!ctx.bound) {
    if (ctx.identity.kind !== 'draft') return;
    const draft = chats.draftFor(ctx.identity.cwd);
    if (!draft) return;
    startDraft(draft, snapshot);
    renderMention();
    renderActive();
    return;
  }
  if (ctx.identity.kind !== 'session') return;
  sendHeld(ctx.identity.pid, snapshot);
}

// Return focus to the box, as Enter keeps it. The button takes focus on
// mousedown, then disables itself once the box is empty, which drops focus to
// the body and loses the next keystroke. Skip after a bare `/rename`: its name
// field closes on blur.
$('send').onclick = () => {
  submit();
  if (($('chat-rename') as HTMLInputElement).hidden) focusBox();
};

/**
 * The script half of the shell's `cursor: text`: a press in the box outside a
 * control puts the caret in the text.
 *
 * `mousedown` with the default prevented: by `click`, the press has moved
 * focus, and on the gap under the last line the caret arrives and leaves.
 * `closest`, not a target test: a press can land on a glyph inside a control.
 */
document.querySelector<HTMLElement>('.shell')?.addEventListener('mousedown', (e) => {
  const at = e.target as HTMLElement | null;
  if (!at || at.closest('button, textarea, input, a, [role="button"], #input')) return;
  e.preventDefault();
  focusBox();
});
