import { closeTicketDetail } from './ticket_details';
/**
 * The requests a session is blocked on: the stepper, the staged picks, and the
 * CTA that sends them — plus, for a session the panel drives itself, the
 * permission prompts that arrive on the same channel (`permission.ts` draws
 * those; everything about *where* they are drawn is here).
 *
 * One list, one source: the session hands over every open request as `pending`,
 * oldest first, straight off its pipe, and every answer goes back as a response
 * addressed by the CLI's own request id. A question reaches the panel on a pipe
 * or it is answered where it was asked, so nothing here has a second shape to
 * compose, and no ask shape is refused.
 */

import { el, imeKey } from './dom';
import { ask, chats, clearWantAskIf, qlaunch, question, scrim, ui, vscode } from './state';
import { awaiting, morph, paintIfChanged } from './kit';
import { bailBox, focusHeld, heldBox, rebuild, sendKey, sweepHeld, type Holder } from './boxes';
import { permissionDialog } from './permission';
import { endable } from './chat';
import { sameSessionStart } from '../core/model';
import type { DialogEdit, DialogState } from '../ui/chat_state';

/**
 * What has been decided about one request and not yet sent: the picks, the
 * words typed under each question, which questions are answered in those words
 * rather than by a label, the words typed into the reply box, whether that box
 * is open, and which question of the request is on screen.
 *
 * `others` is the `Other` row's own selection, kept apart from `picks` because
 * a pick is an *index* the CLI is sent and this row has none — it is a row of
 * the panel's own making, at the position the CLI's widget puts one. It is what
 * decides whether `texts[i]` is sent at all.
 *
 * `texts` is indexed like `picks`, and what it means is stated once in
 * `answerPayload` (`core/answers.ts`), which is the code that reads it.
 *
 * `reply`/`bail` serve every dialog, not only an ask: the permission dialog's
 * deny reason is the same disclosed box with the same two fields behind it.
 *
 * `cur` is the keyboard's row on the shown question, and `-1` until an arrow
 * puts it somewhere. Unset rather than row 0 on purpose: a fresh ask that
 * already highlighted its first option would answer to a stray Enter, and today
 * an Enter with nothing staged does nothing at all. It is state and not focus
 * because every stage rebuilds the rows — a keyboard parked on one of them goes
 * dead on the next repaint, which is the same reason `showAsk` focuses the
 * container.
 */
type AskView = Extract<PendingRequestView, { kind: 'ask' }>;

/**
 * Keep the painted owner when a memo or IME skips an empty paint: the old
 * dialogs remain and their handlers must still address that session.
 */
let shownPid: number | null = null;
let shownStartedAt: number | null = null;

/**
 * Which session a remembered dialog belongs to, in front of the request it is
 * about. **The id alone is not a key.** It is the CLI's own and is scoped to
 * nothing: Grok spells one `String(<jsonrpc id>)` and Codex the same
 * (`core/grok/session.ts`, `core/codex/asks.ts`), so two sessions blocked on
 * their first request both call it `1`.
 *
 * Pruning cannot remove a colliding id: it matches the next session's request.
 * Default to shownPid, not ui.selected: handlers answer the painted owner even
 * after another card is selected. settleSent supplies the report's owner, which
 * may be neither shown nor selected.
 */
const stagedFor = (
  requestId: string,
  pid: number | null = shownPid,
  startedAt: number | null = shownStartedAt
): DialogState | undefined =>
  pid === null || startedAt === null ? undefined : chats.dialog(pid, startedAt, requestId);

const editStaged = (
  requestId: string,
  edit: (dialog: DialogEdit) => void,
  pid: number | null = shownPid,
  startedAt: number | null = shownStartedAt
): boolean =>
  pid !== null && startedAt !== null && chats.editDialog(pid, startedAt, requestId, edit);

/**
 * Key each box by incarnation and request. syncDialogs dropping a request or
 * a new incarnation replacing its record ends the box. Capture the owner now,
 * not in alive, because shownPid may have changed by then.
 */
function holder(requestId: string, say: string): Holder {
  const pid = shownPid;
  const startedAt = shownStartedAt;
  return {
    key: pid + ':' + startedAt + '|' + say,
    alive: () => stagedFor(requestId, pid, startedAt) !== undefined
  };
}

/**
 * Keep successful answers frozen until pending drops them; a refusal restores
 * the controls with the host's reason.
 */
export function settleSent(
  pid: number,
  startedAt: number,
  requestId: string,
  ok: boolean,
  reason?: string
): void {
  // The report's own owner, which the wire has always carried
  // (`RespondResultMessage.pid`) and this used to drop on the floor. Without it
  // a refusal for the session the reader left deleted the freeze and wrote the
  // reason onto whichever session happens to use that request id now — and both
  // of two sessions blocked on their first request call it `1`.
  chats.settleDialog(pid, startedAt, requestId, ok, reason);
  // This is the one layer entry outside renderThread. Guard pid and start:
  // after New or selection, an old refusal could draw over a draft or another
  // session; a previous owner's refusal could clear the layer or overlay its reason.
  const thread = chats.thread();
  if (thread && pid === ui.selected && sameSessionStart(thread.startedAt, startedAt)) {
    renderQuestion(thread);
  }
}

/** Digits only reach `9`, so an ask with more options than that is not ours. */
const MAX_OPTIONS = 9;

/** The modifier that sends from inside a box, in the reader's own spelling. */
const SEND_KEYS = navigator.platform.startsWith('Mac') ? '⌘↵' : 'Ctrl↵';

/** Hold the requested focus across turns: the click precedes the paint that builds the box. */
let focusSay: string | undefined;

/**
 * Include the request id in question, note and reply keys. querySelector takes
 * the first match, so two asks' question 0s would focus the wrong staged text.
 * The same key under the incarnation names holder's box.
 */
const sayKey = (dlg: PendingRequestView, index: number): string =>
  'q:' + dlg.requestId + ':' + index;
const noteKey = (dlg: PendingRequestView, index: number): string =>
  'note:' + dlg.requestId + ':' + index;
const replyKey = (dlg: PendingRequestView): string => 'reply:' + dlg.requestId;

const isAsk = (dlg: PendingRequestView): dlg is AskView => dlg.kind === 'ask';

/**
 * Read the current thread, not a handler's snapshot: a push may have dropped
 * the request, and repainting it would revive both dialog and launcher.
 * Match composer.ts's press-time read. Undefined takes renderQuestion's empty branch.
 */
const repaint = (): void => renderQuestion(chats.thread());

function pickSet(s: DialogEdit, index: number): Set<number> {
  const set = s.picks.get(index) ?? new Set<number>();
  s.picks.set(index, set);
  return set;
}

function stage(dlg: AskView, optionIndex: number): void {
  const s = stagedFor(dlg.requestId);
  const qq = dlg.questions[s?.shown ?? 0];
  if (!s || !qq || s.sending) return;
  editStaged(dlg.requestId, (editing) => {
    const picks = pickSet(editing, editing.shown);
    // Single-select clears Other too; keep its words staged so a misclick is cheap.
    if (!qq.multiSelect) {
      picks.clear();
      editing.others.delete(editing.shown);
    }
    if (picks.has(optionIndex)) picks.delete(optionIndex);
    else picks.add(optionIndex);
    unnote(editing, editing.shown);
  });
  repaint();
}

/**
 * Forget the note where the answer it was about has gone.
 *
 * The note belongs to the **question**, not to the option — that is the CLI's
 * own shape, `annotations` being keyed by question text — so swapping one pick
 * for another inside a question keeps it, and a reader who says "only for
 * staging" and then changes their mind about which row means it still means it.
 * What it cannot survive is the question ceasing to be answered *by a pick*,
 * which is the one rule and covers both ways that happens: every tick taken
 * back on a multi-select, and the `Other` row taking the question over on a
 * single-select — that row clears the picks, and its own words are then the
 * answer, which is why no note is offered beside them. Either way a remark
 * staged behind nothing would be sent about a choice the reader never made.
 *
 * Dropped rather than kept out of the way, unlike the `Other` row's words: that
 * row's text is one click from being the answer again and says so on screen,
 * while a note has nowhere to sit and nothing to hint with. The words are one
 * keystroke to type again.
 */
function unnote(s: DialogEdit, index: number): void {
  if ((s.picks.get(index)?.size ?? 0) > 0) return;
  s.noting.delete(index);
  s.notes.delete(index);
}

function stageOther(dlg: AskView): void {
  const s = stagedFor(dlg.requestId);
  const qq = dlg.questions[s?.shown ?? 0];
  if (!s || !qq || qq.canOther === false || s.sending) return;
  editStaged(dlg.requestId, (editing) => {
    if (editing.others.has(editing.shown)) {
      editing.others.delete(editing.shown);
    } else {
      editing.others.add(editing.shown);
      if (!qq.multiSelect) pickSet(editing, editing.shown).clear();
      unnote(editing, editing.shown);
      // Selecting Other asks to type; focus the field in the paint that creates it.
      focusSay = sayKey(dlg, editing.shown);
    }
  });
  repaint();
}

/**
 * What the cursor walks: the question's own options, the `Other` row the panel
 * puts after them, and the CTA at the end. One numbering for the arrows, the
 * digits and the paint, so `qq.options.length` means the same row in all three.
 *
 * The button being on the walk is what makes the keyboard one rule instead of
 * three. Enter presses whatever the cursor is on — a row stages, the button
 * sends — so there is no key that means "pick" as against "confirm", no press
 * counted to guard the last question, and nothing for a pick-any question to do
 * differently. Going on always costs a move onto a button that says what it
 * does.
 */
const hasOther = (qq: PendingQuestion): boolean => qq.canOther !== false;
const rowCount = (qq: PendingQuestion): number => qq.options.length + (hasOther(qq) ? 2 : 1);
const isOtherRow = (qq: PendingQuestion, row: number): boolean =>
  hasOther(qq) && row === qq.options.length;
const isCtaRow = (qq: PendingQuestion, row: number): boolean =>
  row === qq.options.length + (hasOther(qq) ? 1 : 0);

function stageRow(dlg: AskView, qq: PendingQuestion, row: number): void {
  if (isOtherRow(qq, row)) stageOther(dlg);
  else stage(dlg, row);
}

/**
 * A selected Other must have words, even beside real multi-select picks,
 * or submission would include an unfilled row.
 */
function answeredAt(s: DialogState, i: number): boolean {
  if (s.others.has(i)) return (s.texts.get(i)?.trim() ?? '') !== '';
  return (s.picks.get(i)?.size ?? 0) > 0;
}

/** Whether the CTA may fire: the visible question, and on the last one, all of them. */
function ctaReady(dlg: AskView): boolean {
  const s = stagedFor(dlg.requestId);
  const questions = dlg.questions;
  if (!s) return false;
  if (!answeredAt(s, s.shown)) return false;
  if (s.shown < questions.length - 1) return true;
  return questions.every((_, i) => answeredAt(s, i));
}

/**
 * Take the pid, not a thread snapshot: the session keeps it for life, while
 * a push may already have changed its status or requests.
 */
function confirmAsk(pid: number, dlg: AskView): void {
  const s = stagedFor(dlg.requestId);
  const startedAt = chats.session(pid)?.identity.startedAt;
  const questions = dlg.questions;
  if (!s || startedAt === undefined || !ctaReady(dlg) || s.sending) {
    return;
  }
  if (s.shown < questions.length - 1) {
    editStaged(dlg.requestId, (editing) => {
      editing.shown++;
      // Reset the new question's cursor for the fresh-ask reason in editStaged.
      editing.cur = -1;
    });
    repaint();
    return;
  }
  // One message for the whole ask: the CLI wants every question's answer in the
  // single response that closes the request.
  const picks = questions.map((_, i) => [...(s.picks.get(i) ?? [])].sort((a, b) => a - b));
  // Send text only from selected Other rows. Deselected words remain staged;
  // blank slots preserve picks' indexing for core/answers.ts answerPayload.
  const texts = questions.map((_, i) => (s.others.has(i) ? (s.texts.get(i)?.trim() ?? '') : ''));
  // Send only opened notes with words; annotations for an empty box would be
  // ours, not the reader's. Keep the dense indexing used by texts.
  const notes = questions.map((_, i) => (s.noting.has(i) ? (s.notes.get(i)?.trim() ?? '') : ''));
  // Freeze until pending removes the dialog, or a live CTA looks like a failed
  // send while the push is arriving. Clear the last refusal for this fresh answer.
  editStaged(dlg.requestId, (editing) => {
    editing.failure = undefined;
    editing.sending = 'cta';
  });
  vscode.postMessage({
    type: 'respond',
    pid,
    startedAt,
    requestId: dlg.requestId,
    decision: {
      allow: true,
      picks,
      ...(texts.some(Boolean) ? { texts } : {}),
      ...(notes.some(Boolean) ? { notes } : {})
    }
  });
  repaint();
}

/** An outer code fence is the ask's own packaging, not part of the sample. */
function unfenced(preview: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(preview.trim());
  return match?.[1] ?? preview;
}

/**
 * Share row marks between live dialogs and records. Keep ownOn separate from
 * own: a selected empty Other is real, and an optional string would make the
 * preview show option 0. Records have no cursor, so cur is -1.
 */
type Marks = { picks: Set<number>; cur: number; own: string; ownOn: boolean };

function marksOf(s: DialogState | undefined, shown: number): Marks {
  return {
    picks: new Set(s?.picks.get(shown) ?? []),
    cur: s?.cur ?? -1,
    own: s?.texts.get(shown) ?? '',
    ownOn: s?.others.has(shown) ?? false
  };
}

/**
 * Take answered and onGo, not staged state: records navigate what was answered
 * without staging new picks.
 */
function stepper(
  questions: readonly PendingQuestion[],
  shown: number,
  answered: (i: number) => boolean,
  onGo: (i: number) => void
): HTMLElement {
  const steps = el('div', 'steps');
  questions.forEach((qq, i) => {
    const done = answered(i);
    const chip = el(
      'button',
      'step' + (i === shown ? ' on' : '') + (done && i !== shown ? ' done' : '')
    );
    chip.append(el('span', 'g', done ? '✓' : '□'), el('span', null, qq.header ?? 'Q' + (i + 1)));
    chip.onclick = () => onGo(i);
    steps.append(chip);
  });
  steps.append(el('span', 'cnt', shown + 1 + ' / ' + questions.length));
  return steps;
}

/**
 * Keep samples in both live and recorded asks; an answer chosen from a sample
 * is unreadable without it.
 */
function previewPane(
  qq: PendingQuestion,
  marks: Marks,
  seen?: boolean
): {
  col: HTMLElement;
  showPreview: (index: number, peeking: boolean) => void;
  showOther: (peeking: boolean) => void;
  restore: () => void;
} {
  const cap = el('div', 'qprev-cap');
  const capOf = el('span', 'of');
  const capPeek = el('span', 'peek', 'peeking · not staged');
  cap.append(document.createTextNode('Preview '), capOf, capPeek);
  const pre = el('pre', 'qprev');
  const showPreview = (index: number, peeking: boolean): void => {
    const opt = qq.options[index];
    if (!opt?.preview) return;
    pre.textContent = unfenced(opt.preview);
    capOf.textContent = opt.label;
    capPeek.classList.toggle('show', peeking);
  };
  // Other must replace the last option's sample, or it looks like that answer.
  // Use past tense in records so sent words do not look still pending.
  const showOther = (peeking: boolean): void => {
    pre.textContent = seen
      ? 'These words were sent as written; the model read them in place of a label.'
      : 'Your answer is sent as written; the model reads it in place of a label.';
    capOf.textContent = '— none for your own words';
    capPeek.classList.toggle('show', peeking);
  };
  /**
   * Restore the cursor row, else the staged pick. An unstaged cursor row is a
   * peek, like hover, so arrows do not look like picks.
   */
  const restore = (): void => {
    // At the CTA, show the staged answer it would send.
    if (marks.cur >= 0 && !isCtaRow(qq, marks.cur)) {
      if (isOtherRow(qq, marks.cur)) showOther(!marks.ownOn);
      else showPreview(marks.cur, !marks.picks.has(marks.cur));
      return;
    }
    if (marks.ownOn) showOther(false);
    else showPreview([...marks.picks][0] ?? 0, false);
  };
  const col = el('div', 'qprev-col');
  col.append(cap, pre);
  return { col, showPreview, showOther, restore };
}

/**
 * No hooks means read-only: records offer no staging or hover actions,
 * without adding a readonly flag to the live path.
 */
function optionRows(
  qq: PendingQuestion,
  marks: Marks,
  hooks?: { stage: (index: number) => void; peek?: (index: number) => void; restore?: () => void }
): HTMLElement[] {
  return qq.options.map((opt, oi) => {
    const on = marks.picks.has(oi);
    const b = el(
      hooks ? 'button' : 'div',
      'qopt' + (on ? ' on' : '') + (oi === marks.cur ? ' cur' : '') + (hooks ? '' : ' seen')
    );
    b.append(
      el('span', 'kbd', oi < MAX_OPTIONS ? String(oi + 1) : ''),
      el('span', 'mark ' + (qq.multiSelect ? 'many' : 'one'))
    );
    const txt = el('span', 'txt');
    txt.append(el('span', 'qopt-label', opt.label));
    if (opt.description) txt.append(el('span', 'qopt-desc', opt.description));
    b.append(txt);
    // Label recorded picks in words; green alone gives no label or control.
    if (!hooks && on) b.append(el('span', 'answered', 'answered'));
    if (hooks) {
      b.onclick = () => hooks.stage(oi);
      if (hooks.peek && hooks.restore) {
        // Restore the staged preview after hover so comparison does not change the pick.
        const peek = (): void => hooks.peek?.(oi);
        b.onmouseenter = peek;
        b.onfocus = peek;
        b.onmouseleave = hooks.restore;
      }
    }
    return b;
  });
}

/**
 * The last row of the option list: this question answered in the reader's own
 * words. Row `N+1`, which is where the CLI's own widget puts `Other`, wearing
 * the same box, the same mark and the next digit.
 *
 * Keep deselected words visible: the row is one click from being the answer again.
 * Only selected rows have a field, so pick and text read as one object.
 * No hooks means read-only. dlg and shown supply the field's staged state.
 * Share this row with records so the own-words gutter keeps its shape.
 * No reachability gate: pending comes from the live half, which only the pipe's window has.
 */
function otherRow(
  qq: PendingQuestion,
  marks: Marks,
  hooks?: { dlg: AskView; shown: number; peek?: (peeking: boolean) => void }
): HTMLElement {
  const on = marks.ownOn;
  const text = marks.own;
  const cur = marks.cur === qq.options.length;
  const row = el(
    'div',
    'qopt other' + (on ? ' on' : '') + (cur ? ' cur' : '') + (hooks ? '' : ' seen')
  );

  // Keep the pick separate from the field, or a caret click would press it.
  // Records have no field or action, so retain the same gutter as a div.
  const pick = el(hooks ? 'button' : 'div', 'qother-pick');
  const digit = qq.options.length + 1;
  pick.append(
    el('span', 'kbd', digit <= MAX_OPTIONS ? String(digit) : ''),
    el('span', 'mark ' + (qq.multiSelect ? 'many' : 'one'))
  );
  const txt = el('span', 'txt');
  const dim = hooks && !on && !text.trim() ? ' dim' : '';
  txt.append(el('span', 'qopt-label' + dim, hooks ? 'Something else…' : 'Your own words'));
  // Echo words only while a live field is hidden; records always show the answer.
  if (!on || !hooks) {
    // Invite typing only on live rows; records already have their answer.
    if (text.trim()) txt.append(el('span', 'qother-said', text));
    else if (hooks) txt.append(el('span', 'qopt-desc', 'Answer in your own words.'));
  }
  pick.append(txt);
  // Put answered inside the gutter: only a line across the column lets
  // margin-left: auto reach its right edge.
  if (!hooks && on) pick.append(el('span', 'answered', 'answered'));
  row.append(pick);
  if (!hooks) return row;

  const { dlg, shown, peek } = hooks;
  const s = stagedFor(dlg.requestId);
  pick.onclick = () => stageOther(dlg);

  if (on) {
    const pid = shownPid;
    const say = sayKey(dlg, shown);
    const box = heldBox({
      ...holder(dlg.requestId, say),
      cls: 'qother-in',
      say,
      value: text,
      placeholder: 'Type your answer. It is sent as written.',
      label: 'Your own words',
      // Freeze to preserve the sent words on repaint; see noteBox's readOnly reason.
      readOnly: s?.sending !== undefined,
      onChange: (typed) => {
        if (stagedFor(dlg.requestId)?.sending) return;
        editStaged(dlg.requestId, (editing) => editing.texts.set(shown, typed));
        // Repaint so CTA and chips follow the text; rebuild keeps the box node.
        repaint();
      },
      onKey: sendKey(() => {
        if (pid !== null) confirmAsk(pid, dlg);
      })
    });
    row.append(box.node);
  }
  if (peek) {
    row.onmouseenter = () => peek(!on);
    row.onmouseleave = () => peek(false);
  }
  return row;
}

/**
 * A word about the pick, drawn under the list it is about.
 *
 * Not a row, and deliberately: it annotates an answer rather than being one, so
 * it takes no digit, no mark and no place on the arrow walk — the numbering the
 * digits, the cursor and the paint share stays `options.length + 2`. It never
 * gates the CTA either. A pick is a whole answer, and this is the sentence after
 * it.
 *
 * Offered only where a real option is picked. The `Other` row's words already
 * *are* the answer, so a note beside them would be a second one wearing another
 * name — and the CLI's `annotations` are read against the answer they qualify.
 *
 * The box does not repaint on input, unlike the `Other` row's: nothing on
 * screen depends on what is in it, and a repaint per keystroke is a caret to
 * put back for no reason.
 */
function noteBox(dlg: AskView, shown: number): HTMLElement | undefined {
  if (dlg.canNote === false) return undefined;
  const s = stagedFor(dlg.requestId);
  if (!s || (s.picks.get(shown)?.size ?? 0) === 0) return undefined;
  if (!s.noting.has(shown)) {
    const add = el('button', 'qnote-add', 'Add a note') as HTMLButtonElement;
    add.dataset.tip =
      'Say why, in your own words. It rides beside the answer — what you picked is unchanged.';
    add.onclick = () => {
      if (stagedFor(dlg.requestId)?.sending) return;
      editStaged(dlg.requestId, (editing) => editing.noting.add(shown));
      // Focus the new box in the paint that creates it; see stageOther.
      focusSay = noteKey(dlg, shown);
      repaint();
    };
    // Show the frozen state as well as guarding clicks, or the control silently
    // swallows presses. Use awaiting without Sending because this button never sends.
    awaiting(add, s.sending);
    return add;
  }
  const wrap = el('div', 'qnote');
  wrap.append(el('span', 'qnote-cap', 'Note · sent with your answer'));
  const pid = shownPid;
  const say = noteKey(dlg, shown);
  const box = heldBox({
    ...holder(dlg.requestId, say),
    cls: 'qnote-in',
    say,
    value: s.notes.get(shown) ?? '',
    placeholder: 'Sent beside the answer, not instead of it. ' + SEND_KEYS + ' sends.',
    label: 'Note',
    // Freeze with the dialog so a repaint shows the words that were sent.
    readOnly: s.sending !== undefined,
    onChange: (typed) => {
      if (stagedFor(dlg.requestId)?.sending) return;
      editStaged(dlg.requestId, (editing) => editing.notes.set(shown, typed));
    },
    onKey: sendKey(() => {
      if (pid !== null) confirmAsk(pid, dlg);
    })
  });
  wrap.append(box.node);
  return wrap;
}

/** The tertiary control every dialog of an owned session carries: end the turn
 *  the request is blocking. There is no "withdraw this request" subtype, so an
 *  interrupt is what makes the CLI retract it — and the dialog goes with the
 *  push that follows, needing nothing local. Offered only where the host has an
 *  answer for it, which is `endable`'s rule and not a second copy of it. */
function cancelButton(t: ThreadView): HTMLButtonElement | undefined {
  if (!endable(t)) return undefined;
  const cancel = el('button', 'qcancel', 'Cancel this turn') as HTMLButtonElement;
  cancel.dataset.tip = 'End the turn. The session drops the request and goes back to its prompt.';
  cancel.onclick = () =>
    vscode.postMessage({ type: 'interrupt', pid: t.pid, startedAt: t.startedAt });
  return cancel;
}

/** Opening must focus #question: digits and Enter are bound there, not on document. */
function showAsk(): void {
  closeTicketDetail();
  ask.hidden = false;
  scrim.hidden = false;
  // Focus the container, not an option: repaint never replaces it, so keys survive staging.
  question.focus();
}

/**
 * Guard the poll's empty branch so an askless session cannot keep stealing
 * focus back to the composer.
 */
function hideAsk(): void {
  if (ask.hidden) return;
  ask.hidden = true;
  scrim.hidden = true;
  if (!qlaunch.hidden) qlaunch.focus();
}

function shownOf(dlg: AskView): number {
  return Math.min(stagedFor(dlg.requestId)?.shown ?? 0, dlg.questions.length - 1);
}

function headline(dlg: PendingRequestView): string {
  if (dlg.kind !== 'ask') {
    return dlg.label;
  }
  const qq = dlg.questions[shownOf(dlg)];
  return qq ? (qq.header ? qq.header + ' — ' : '') + qq.question : dlg.requestId;
}

/** Keep preview in a separate column so it cannot move an option row. */
function askDialog(t: ThreadView, dlg: AskView): HTMLElement {
  const questions = dlg.questions;
  const shown = shownOf(dlg);
  const qq = questions[shown];
  const root = el('div', 'pdlg');
  if (!qq) return root;

  const s = stagedFor(dlg.requestId);
  const marks = marksOf(s, shown);
  const block = el('div', 'qblock');
  const col = el('div', 'qcol');
  if (questions.length > 1) {
    col.append(
      stepper(
        questions,
        shown,
        (i) => (s ? answeredAt(s, i) : false),
        (i) => {
          if (!s) return;
          editStaged(dlg.requestId, (editing) => {
            editing.shown = i;
            editing.cur = -1;
          });
          repaint();
        }
      )
    );
  }

  const hdr = el('div', 'qhdr');
  hdr.append(el('span', null, qq.header ?? 'Question'));
  hdr.append(el('span', 'cnt', qq.multiSelect ? 'pick any' : 'pick one'));
  col.append(hdr, el('div', 'qtext', qq.question));

  const picks = marks.picks;
  const opts = el('div', 'qopts');
  const previews = qq.options.some((o) => o.preview);
  const { col: prevCol, showPreview, showOther, restore } = previewPane(qq, marks);

  opts.append(
    ...optionRows(qq, marks, {
      stage: (oi) => stage(dlg, oi),
      ...(previews ? { peek: (oi) => showPreview(oi, !picks.has(oi)), restore } : {})
    })
  );
  // Offer Other only when the response schema admits it.
  if (hasOther(qq)) {
    opts.append(
      otherRow(qq, marks, {
        dlg,
        shown,
        ...(previews ? { peek: (peeking: boolean) => (peeking ? showOther(true) : restore()) } : {})
      })
    );
  }
  col.append(opts);
  const note = noteBox(dlg, shown);
  if (note) col.append(note);
  block.append(col);
  if (previews) {
    restore();
    block.append(prevCol);
  }

  // Keep the CTA outside the scrolling block so it cannot scroll out of reach.
  root.append(block);

  // Talk-back is not an answer; keep it outside the scrolling block.
  if (dlg.canReply !== false) {
    root.append(
      bailBox({
        open: s?.bail ?? false,
        trigger: 'Don’t answer — talk back instead',
        hint: 'the model reads it and can ask again',
        cap: 'Answers nothing',
        why:
          'The question is refused and your words go back in its place. The turn keeps ' +
          'running, and the session can ask you again.',
        back: '← back to the options',
        onOpen: (open) => {
          if (s) {
            editStaged(dlg.requestId, (editing) => {
              editing.bail = open;
            });
            if (open) focusSay = replyKey(dlg);
          }
          repaint();
        },
        // Share sending so a reply freezes its button and the CTA together.
        say: {
          placeholder: 'What should it know instead?',
          action: 'Send · no answer',
          cls: 'qreply',
          // The CLI's own `Chat about this` is a denial carrying feedback, and a
          // denial carrying none says nothing the model can act on.
          needsText: true,
          key: replyKey(dlg),
          hold: holder(dlg.requestId, replyKey(dlg)),
          value: s?.reply ?? '',
          sent: s?.sending,
          at: 'reply',
          onType: (text) => {
            if (s) editStaged(dlg.requestId, (editing) => (editing.reply = text));
          },
          onSend: (message) => {
            if (stagedFor(dlg.requestId)?.sending) return;
            editStaged(dlg.requestId, (editing) => {
              editing.failure = undefined;
              editing.sending = 'reply';
            });
            vscode.postMessage({
              type: 'respond',
              pid: t.pid,
              startedAt: t.startedAt,
              requestId: dlg.requestId,
              decision: { allow: false, message }
            });
            repaint();
          }
        }
      })
    );
  }

  const row = el('div', 'qrow');
  const last = shown === questions.length - 1;
  const other = s?.others.has(shown) ?? false;
  const typed = (s?.texts.get(shown) ?? '').trim() !== '';
  const label = !last
    ? 'Next'
    : questions.length > 1 || qq.multiSelect
      ? 'Submit'
      : other
        ? 'Send answer'
        : picks.size
          ? 'Confirm “' + (qq.options[[...picks][0] ?? 0]?.label ?? '') + '”'
          : 'Confirm';
  const cta = el(
    'button',
    'cta' + (isCtaRow(qq, s?.cur ?? -1) ? ' cur' : ''),
    label
  ) as HTMLButtonElement;
  cta.disabled = !ctaReady(dlg);
  cta.onclick = () => confirmAsk(t.pid, dlg);
  // Keep the action label separate from the sending state.
  awaiting(cta, s?.sending, 'cta');
  row.append(cta);
  // Show field keys for Other and notes: digits and Enter edit text there,
  // and this strip explains why option shortcuts stopped.
  const noting = s?.noting.has(shown) ?? false;
  const keys =
    other || noting
      ? (other && !typed ? 'type your answer' : SEND_KEYS + ' to send') +
        ' · esc to go back to the list'
      : '↑↓ to move · 1–9 or ↵ to stage · ' + SEND_KEYS + ' to ' + (last ? 'send' : 'go on');
  row.append(el('span', 'qkeys', keys));
  // Put the turn exit at the far end of the send row so both exits are readable.
  const cancel = cancelButton(t);
  if (cancel) row.append(cancel);
  root.append(row);
  return root;
}

/**
 * The record a reader has opened, if any: whose session it is, what it holds,
 * and which of its questions is on screen.
 *
 * Module state beside `staged`, and for the same reason — the 3s poll repaints
 * the layer, and what a reader is looking at must survive that. It is a
 * temporary override of the layer rather than a fourth sheet: the 440px a sheet
 * has is not enough for the preview column, and an answer picked on the strength
 * of a sample cannot be read back without it.
 *
 * One rule covers every collision with a live request, and it is that clearing
 * this repaints whatever is pending.
 */
let replay: { pid: number; record: AnsweredAskView; shown: number; over: Set<string> } | undefined;

/** What was pending when a record was opened, so a request *arriving* can be
 *  told from one the reader knowingly opened a record over.
 *
 *  A set and not a joined key, because only arrival may clear a record: an
 *  equality test fires in both directions, so a request being withdrawn — or a
 *  turn simply ending — would take the record off the screen of somebody
 *  reading it. */
const pendingOver = (t: ThreadView | undefined): Set<string> =>
  new Set((t?.pending ?? []).map((c) => c.requestId));

/** Open records from the thread where they are read. */
export function openReplay(pid: number, record: AnsweredAskView, at: number): void {
  replay = { pid, record, shown: at, over: pendingOver(chats.thread()) };
  renderQuestion(chats.thread());
  showAsk();
}

/**
 * All record exits repaint pending requests. Return whether a record was up:
 * ask.hidden cannot tell whether the newly restored live dialog should stay open.
 */
export function clearReplay(): boolean {
  if (!replay) return false;
  replay = undefined;
  renderQuestion(chats.thread());
  return true;
}

/** Pending requests decide whether leaving a record closes the layer. */
const blocked = (): boolean => (chats.thread()?.pending ?? []).length > 0;

/**
 * Key everything replayDialog draws. A shared header or pick index cannot
 * distinguish records with different questions and option labels: header is
 * about a dozen characters and generic by design.
 * Share the key with chat_turns.ts's pills instead of defining it twice.
 */
export const recordKey = (record: AnsweredAskView): string =>
  [
    // Stringify whole questions so labels cannot collide with a chosen separator.
    JSON.stringify(record.questions),
    record.picks.map((p) => p.join(',')).join(';'),
    record.texts.join('\u0000'),
    record.notes.join('\u0000')
  ].join('|');

/** Whether question `i` of a record was answered at all — 3 of the 863 surveyed
 *  2026-08-12 (`cli_state/claude/transcript.md`) are answered in part, and a
 *  question nobody answered is drawn as one. */
function recorded(record: AnsweredAskView, i: number): boolean {
  return (record.picks[i]?.length ?? 0) > 0 || (record.texts[i] ?? '').trim() !== '';
}

/**
 * Use the live dialog's drawing with no answer controls. Keep recorded picks
 * green: amber means staged and not sent elsewhere in the panel.
 */
function replayDialog(open: { record: AnsweredAskView; shown: number }): HTMLElement {
  const { record, shown } = open;
  const root = el('div', 'pdlg replay');
  const qq = record.questions[shown];
  if (!qq) return root;

  const cap = el('div', 'qseen-cap');
  cap.append(el('span', 'dot'), el('span', null, 'Answered question'));
  root.append(cap);

  const block = el('div', 'qblock');
  const col = el('div', 'qcol');
  if (record.questions.length > 1) {
    col.append(
      stepper(
        record.questions,
        shown,
        (i) => recorded(record, i),
        (i) => {
          if (replay) replay.shown = i;
          renderQuestion(chats.thread());
        }
      )
    );
  }
  // A record can be answered in part — 3 of the 863 measured are — so a
  // question nobody answered says so rather than claiming a pick it has not
  // marked on any row.
  const answered = recorded(record, shown);
  // Count marked rows, including own words, so the count matches what is green.
  const picked = record.picks[shown]?.length ?? 0;
  const own = record.texts[shown] ?? '';
  const marked = picked + (own.trim() ? 1 : 0);
  const hdr = el('div', 'qhdr');
  hdr.append(el('span', null, qq.header ?? 'Question'));
  hdr.append(
    el(
      'span',
      'cnt',
      !answered
        ? 'not answered'
        : picked === 0
          ? 'answered in words'
          : marked > 1
            ? 'picked several'
            : 'picked'
    )
  );
  col.append(hdr, el('div', 'qtext', qq.question));

  const marks: Marks = {
    picks: new Set(record.picks[shown] ?? []),
    cur: -1,
    own,
    ownOn: own.trim() !== ''
  };
  const opts = el('div', 'qopts');
  opts.append(...optionRows(qq, marks));
  // Draw recorded own words with Other's row, and omit it when no words were sent.
  if (marks.ownOn) opts.append(otherRow(qq, marks));
  col.append(opts);

  const note = (record.notes[shown] ?? '').trim();
  if (note) {
    const wrap = el('div', 'qnote seen');
    wrap.append(
      el('span', 'qnote-cap', 'Note · sent with your answer'),
      el('div', 'qnote-said', note)
    );
    col.append(wrap);
  }
  block.append(col);
  // Show previews only for answered questions, or restore's option-0 fallback
  // would put an unpicked sample and label where the answer belongs.
  if (answered && qq.options.some((o) => o.preview)) {
    const pane = previewPane(qq, marks, true);
    pane.restore();
    block.append(pane.col);
  }
  root.append(block);
  // Keep the CTA row's height in records, with only the exit button.
  const row = el('div', 'qrow seen');
  const close = el('button', 'qclose', 'Close') as HTMLButtonElement;
  close.onclick = () => {
    clearReplay();
    // Leave a record, not a pending live dialog. With nothing pending, close the layer.
    if (!blocked()) hideAsk();
  };
  row.append(close);
  root.append(row);
  return root;
}

/**
 * Use the wide layer so a tall ask cannot grow the composer and clip its CTA.
 * Options only stage because a misclick is expensive to undo; permission
 * buttons decide immediately (permission.ts).
 */
export function renderQuestion(pushed: ThreadView | undefined): void {
  // Guard at the paint boundary: pushes can lag selection or pid reuse.
  const active = chats.active();
  const t =
    pushed &&
    active?.kind === 'session' &&
    pushed.pid === active.pid &&
    sameSessionStart(pushed.startedAt, active.startedAt)
      ? { ...pushed, startedAt: active.startedAt }
      : undefined;
  const dialogs = t?.pending ?? [];
  // Clear records only for arrivals; a new request needs the reader. Keep records
  // opened over existing requests, with staged picks intact. Withdrawals and turn
  // ends must not dismiss reading; pendingOver distinguishes these cases.
  const over = replay?.over;
  if (over && dialogs.some((c) => !over.has(c.requestId))) replay = undefined;
  // Let wantAsk beat the record before its early return; the waiting pill names a live question.
  if (replay && ui.wantAsk === t?.pid) replay = undefined;
  // Compare replay with selection, not t, which the guard may have removed;
  // leaving the session must close its record even without a new push.
  if (replay && replay.pid !== ui.selected) replay = undefined;
  const seen = replay;
  if (!t || !dialogs.length) {
    if (t) chats.syncDialogs(t.pid, t.startedAt, []);
    qlaunch.hidden = true;
    if (!seen) hideAsk();
    // Use the same memo so returning requests repaint. Empty cannot collide with
    // request JSON. Include the record key, or two records with no pending requests
    // would share empty and swallow the second paint.
    paintIfChanged(
      question,
      seen ? `replay|${seen.pid}|${seen.shown}|${recordKey(seen.record)}` : 'empty',
      () => question.replaceChildren(...(seen ? [replayDialog(seen)] : []))
    );
    // Sweep even when the memo skips: removed requests must release parked boxes.
    sweepHeld();
    return;
  }

  // Set whose dialogs these are before anything below reads owner-bound state.
  shownPid = t.pid;
  shownStartedAt = t.startedAt;
  chats.syncDialogs(
    t.pid,
    t.startedAt,
    dialogs.map((dialog) => dialog.requestId)
  );

  const first = dialogs[0] as PendingRequestView;
  // The launcher: what is waiting and how much of it. Every request that gets
  // here is answerable — it came off the pipe, and a response addressed by its
  // own id has no shape it cannot carry.
  //
  // Morphed rather than rebuilt. They are two spans hanging off the button, so
  // replacing them blurs nothing — but they are also the whole of what a press
  // on the button can land on, and this runs on every 3s push. A span swapped
  // between the mousedown and the mouseup detaches the node the press landed on,
  // and no click is dispatched at all: the one control between a blocked session
  // and its dialog ignores that press entirely. `childrenOnly` leaves the button
  // itself alone, which is what focus returns to.
  const at =
    dialogs.length > 1
      ? dialogs.length + ' waiting'
      : isAsk(first)
        ? shownOf(first) + 1 + ' of ' + first.questions.length
        : 'permission';
  qlaunch.hidden = false;
  morph(qlaunch, [el('span', 'q', headline(first)), el('span', 'at', at)]);

  // Keep the launcher naming the live question while a record covers it.
  // Picks remain staged until their request is removed, not until it is read.
  if (seen) {
    // Keep pending out of the record key: departures must not repaint a record
    // being read. Park live boxes so closing the record restores them.
    paintIfChanged(question, `replay|${seen.pid}|${seen.shown}|${recordKey(seen.record)}`, () =>
      question.replaceChildren(replayDialog(seen))
    );
    sweepHeld();
    return;
  }

  // Key requests as well as picks so an edit under the same id repaints.
  const sig = [
    dialogs.map((c) => JSON.stringify(c)).join('~'),
    dialogs
      .map((c) => {
        const s = stagedFor(c.requestId);
        const picks = [...(s?.picks ?? [])].map(([i, set]) => i + ':' + [...set].join(','));
        // Key typed words, Other selections and reply disclosure so the CTA and rows
        // repaint when text changes, as they do for picks.
        const texts = [...(s?.texts ?? [])].map(([i, text]) => i + ':' + text);
        const others = [...(s?.others ?? [])].join(',');
        // Key note disclosure, not words: no paint depends on note text, so a keystroke
        // repaint would only put the caret back.
        const noting = [...(s?.noting ?? [])].join(',');
        return [
          s?.shown ?? 0,
          // Key cur so arrow moves repaint the highlighted row.
          s?.cur ?? -1,
          picks.join(';'),
          texts.join(';'),
          others,
          noting,
          s?.bail ? 'bail' : '',
          s?.reply ?? '',
          // Key sending so freezing repaints; use the control key, not a flag,
          // because it identifies which control is frozen.
          s?.sending ?? '',
          // Key the refusal so it repaints on the dialog.
          s?.failure ?? ''
        ].join('/');
      })
      .join('~')
  ].join('|');
  paintIfChanged(question, sig, () => {
    // Rebuild handlers around held boxes: each closes over the current dialog
    // while boxes retain caret, selection and history (boxes.ts rebuild).
    rebuild(
      question,
      dialogs.map((dlg) => {
        const s = stagedFor(dlg.requestId);
        const node =
          dlg.kind === 'ask'
            ? askDialog(t, dlg)
            : permissionDialog(
                dlg,
                (decision, pressed) => {
                  // Freeze the pressed permission button until the push removes it. It is the
                  // decision itself, with no staged picks.
                  if (stagedFor(dlg.requestId)?.sending) return;
                  editStaged(dlg.requestId, (editing) => {
                    editing.failure = undefined;
                    editing.sending = pressed;
                  });
                  vscode.postMessage({
                    type: 'respond',
                    pid: t.pid,
                    startedAt: t.startedAt,
                    requestId: dlg.requestId,
                    decision
                  });
                  repaint();
                },
                // Keep disclosure and reason text in the ask reply slot so a poll cannot
                // close the permission box or erase its words.
                {
                  open: s?.bail ?? false,
                  text: s?.reply ?? '',
                  key: replyKey(dlg),
                  hold: holder(dlg.requestId, replyKey(dlg)),
                  onOpen: (open) => {
                    if (s) {
                      editStaged(dlg.requestId, (editing) => {
                        editing.bail = open;
                      });
                      if (open) focusSay = replyKey(dlg);
                    }
                    repaint();
                  },
                  onType: (text) => {
                    if (s)
                      editStaged(dlg.requestId, (editing) => {
                        editing.reply = text;
                      });
                  }
                },
                s?.sending
              );
        // Add permission cancellation here: asks have a CTA row, permissions do not,
        // and permission.ts should not learn about interrupts.
        if (dlg.kind !== 'ask') {
          const cancel = cancelButton(t);
          if (cancel) {
            const extra = el('div', 'qxrow');
            extra.append(cancel);
            node.append(extra);
          }
        }
        // Put refusals last under the restored controls on either dialog: the reader
        // must see why the answer went nowhere.
        const why = s?.failure;
        if (why) node.append(el('div', 'qfail', why));
        return node;
      })
    );
    sweepHeld();
    // Scroll the cursor into view so an off-screen highlight does not look stuck.
    // nearest leaves a visible row alone.
    question.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
    // Focus the requested box before restoring list focus; its creation is the
    // first moment there is a field to type in.
    const want = focusSay;
    focusSay = undefined;
    if (want && focusHeld(question.querySelector('[data-say="' + want + '"]'))) return;
    // Every stage rebuilds the block, which destroys whichever option row had
    // focus — and with focus fallen back to the body the digits and the Enter
    // stop arriving, while clicking carries on working. That failure is silent
    // and survives a casual look, so the container takes the keyboard back
    // whenever a repaint has dropped it. `#question` itself is never rebuilt,
    // and a box that had the caret has it still (`rebuild`).
    //
    // A box that went read-only under the caret (the send it just made) can no
    // longer take keys, and Chromium may move its focus to the body; the list
    // takes it, so Escape still reaches the layer.
    const caret = document.activeElement;
    const frozen = caret?.closest('.prose') && caret.getAttribute('contenteditable') === 'false';
    if (!ask.hidden && (frozen || !question.contains(caret))) question.focus();
  });

  // Honor wantAsk after paint so the newly built dialog can take focus.
  if (ui.wantAsk === t.pid) {
    clearWantAskIf(t.pid);
    showAsk();
  }
}

// Toggle the launcher as menu triggers do. Use the scrim, not a document
// listener, so a transcript click cannot dismiss the layer.
qlaunch.onclick = () => {
  // A launcher press must show its live question. Test clearReplay before hidden,
  // or an already visible record would make the press close the restored dialog.
  if (clearReplay() || ask.hidden) showAsk();
  else hideAsk();
};
// Scrim and Escape dismiss the layer for both live dialogs and records.
scrim.onclick = () => {
  clearReplay();
  hideAsk();
};

// Keys belong to the block, not the document: `#input` is a sibling, so nothing
// here can swallow a keystroke meant for the composer's own box. Escape rides
// the same listener rather than a second one on the document — focus is inside
// here whenever the layer is open, which is exactly when Escape should close it.
//
// They drive the oldest ask on screen, which is the one the launcher names. A
// permission dialog takes no keystroke at all: allowing a tool call is not
// something a stray digit should be able to do.
//
// Two ways to the same pick, because there are two ways to read the list. A
// digit is for a row you can see the number of; the arrows are for one you are
// reading the descriptions of, and are the terminal's own gesture — arrow to a
// row, Enter to take it. The CTA is the last stop on that walk, which is what
// leaves Enter one meaning: press what the cursor is on.
question.addEventListener('keydown', (e) => {
  // An IME's own keys, Escape included: Japanese and Chinese IMEs cancel a
  // conversion on it, and that must not also take the reader out of the box.
  if (imeKey(e)) return;
  const box = e.target instanceof Element ? e.target.closest('.prose') : null;
  if (e.key === 'Escape') {
    e.preventDefault();
    // First Escape leaves a field for the list and restores digits; the next
    // closes the layer.
    if (box) question.focus();
    else {
      clearReplay();
      hideAsk();
    }
    return;
  }
  // After Escape so records can still close from the keyboard. Disable answer
  // keys in records: otherwise Enter could send a live ask's staged picks behind one.
  if (replay) return;
  const t = chats.thread();
  const dlg = (t?.pending ?? []).find(isAsk);
  const s = dlg && stagedFor(dlg.requestId);
  if (!t || !dlg || !s) return;
  // Let fields keep digits, arrows and Enter for editing. sendKey claims their
  // send chord before this listener.
  if (box) return;
  const qq = dlg.questions[s.shown];
  if (!qq) return;

  // An unset cursor lands at the near end so its first move is visible;
  // arrowing highlights without staging.
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const rows = rowCount(qq);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    editStaged(dlg.requestId, (editing) => {
      editing.cur =
        editing.cur < 0 ? (step === 1 ? 0 : rows - 1) : (editing.cur + step + rows) % rows;
    });
    repaint();
    return;
  }
  // Step freely without the CTA gate: viewing is not answering. Clamp at the
  // sequence's ends rather than wrapping.
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const to = s.shown + (e.key === 'ArrowRight' ? 1 : -1);
    if (to < 0 || to >= dlg.questions.length) return;
    e.preventDefault();
    editStaged(dlg.requestId, (editing) => {
      editing.shown = to;
      editing.cur = -1;
    });
    repaint();
    return;
  }
  // Enter stages the cursor row or presses the CTA; an unset cursor uses the CTA
  // so mouse and digit picks still send with Enter. The modifier sends from any
  // row to avoid walking long asks; as in Other's field, it prevents an accidental press.
  if (e.key === 'Enter') {
    e.preventDefault();
    const onRow = s.cur >= 0 && !isCtaRow(qq, s.cur) && !(e.metaKey || e.ctrlKey);
    if (onRow) stageRow(dlg, qq, s.cur);
    else confirmAsk(t.pid, dlg);
    return;
  }
  const digit = Number(e.key);
  if (!Number.isInteger(digit) || digit < 1 || digit > MAX_OPTIONS) return;
  // The digit after the last option is the reader's own words, which is where
  // the CLI's widget puts it too.
  const other = hasOther(qq) && digit === qq.options.length + 1;
  if (digit > qq.options.length && !other) return;
  e.preventDefault();
  if (other) stageOther(dlg);
  else stage(dlg, digit - 1);
});
