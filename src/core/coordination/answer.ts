/**
 * One session answering another's open question: which request it may answer,
 * and the prose the answer is delivered as.
 *
 * The answer is a message, not a response on the question's own wire. The
 * asker is interrupted — every brand withdraws an open question on interrupt
 * (Claude `control_cancel_request`, Grok failing the RPC, Codex retracting the
 * callback) — and the prose arrives as its next prompt, as a peer's message.
 * Decided 2026-10-06 over answering inside the turn: mapping one answer onto
 * three CLIs' question wires differed per brand at every field, where a
 * message is the same on all of them.
 */

import { isQuestion, type PendingRequest } from '../live';
import { checkVerbSend } from './send';

/** One question's answer as the answerer writes it: words, or several for a
 *  multi-select. Not matched against the options — it is prose. */
export type AnswerEntry = { answer: string | string[] };

/**
 * The open question `askId` names, or why it cannot be answered.
 *
 * **A permission is never answered by a session.** Any agent could get past
 * its own prompt by asking a peer to approve it, so only a person grants one,
 * on the session's dialog. `--force` does not reach this — nor the rule that
 * the question stand alone, which is the same rule seen from the interrupt.
 */
export function openQuestion(
  pending: readonly PendingRequest[],
  askId: string
): { ok: true; request: PendingRequest } | { ok: false; reason: string } {
  const request = pending.find((open) => open.requestId === askId);
  if (!request) {
    return { ok: false, reason: 'That question is no longer open.' };
  }
  if (!request.ask) {
    return {
      ok: false,
      reason:
        "That is a permission prompt. A permission is granted only by a person, on that session's dialog."
    };
  }
  if (!isQuestion(request)) {
    return {
      ok: false,
      reason: 'That question could not be read; it is answered only on its dialog.'
    };
  }
  // The interrupt that withdraws this question withdraws every request open
  // beside it (Grok fails each pending RPC, Codex retires the turn's requests,
  // Claude cancels each control request) — a permission among them unseen.
  if (pending.length > 1) {
    return {
      ok: false,
      reason:
        `That session has ${pending.length} requests open, and answering one would withdraw ` +
        'them all. It is answered only on its dialog; tell the user.'
    };
  }
  return { ok: true, request };
}

/**
 * The answers as the message the asker reads: one `"question"="answer"` line
 * per question, the shape Claude's own tool result gives a click, under a line
 * saying why the dialog closed.
 *
 * `entries` is `unknown` because it is another program's JSON. Strict about
 * shape — one entry per question, in order, and only `answer` in each — so a
 * misplaced answer is refused rather than delivered against the wrong
 * question.
 */
export function answerProse(
  request: Pick<PendingRequest, 'questions'>,
  entries: unknown
): { ok: true; text: string } | { ok: false; reason: string } {
  const questions = request.questions ?? [];
  const count = `${questions.length} question${questions.length === 1 ? '' : 's'}`;
  if (!Array.isArray(entries) || entries.length !== questions.length) {
    return {
      ok: false,
      reason: `That request has ${count}; --answers takes one entry per question, in order.`
    };
  }
  const lines: string[] = [];
  for (const [i, question] of questions.entries()) {
    const entry: unknown = entries[i];
    const n = i + 1;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `Entry ${n} is not an object.` };
    }
    const stray = Object.keys(entry).find((key) => key !== 'answer');
    if (stray !== undefined) {
      return { ok: false, reason: `Entry ${n} has an unknown field '${stray}'; it takes answer.` };
    }
    const { answer } = entry as { answer?: unknown };
    const words = (Array.isArray(answer) ? answer : [answer]).filter(
      (one): one is string => typeof one === 'string' && one.trim() !== ''
    );
    if (!words.length || (Array.isArray(answer) && words.length !== answer.length)) {
      return {
        ok: false,
        reason: `Entry ${n} needs an answer: words, or a list of them for a multi-select.`
      };
    }
    // Quoted by `JSON.stringify`, both halves: an answer holding a newline or
    // a quote would otherwise write a line of its own beside the real ones.
    lines.push(`${JSON.stringify(question.question)}=${JSON.stringify(words.join(', '))}`);
  }
  return {
    ok: true,
    text:
      'Answers to the question you asked. Your dialog was closed so they could reach you; ' +
      'continue as if they had been picked there.\n' +
      lines.join('\n')
  };
}

/**
 * A person's typed answer as the asker reads it, under a line saying where it
 * came from and why the dialog closed — `answerProse`'s fact, stated for a
 * person rather than a peer. Worded clear of the fake CLIs' trigger words
 * (`serve_owned.test.ts`), because a lead line is a prompt like any other.
 */
export function personAnswerProse(text: string): string {
  return (
    'The person answered your question from outside the panel. Its dialog was closed so ' +
    'their answer could reach you; continue as if they had given it there.\n' +
    text
  );
}

/**
 * The window's whole decision on an `answer` request: the question still
 * open, then everything `checkVerbSend` decides about a message. The window's
 * check is the one that counts; `serve` says why it checks once more.
 */
export function checkVerbAnswer(
  input: Parameters<typeof checkVerbSend>[0] & {
    pending: readonly PendingRequest[];
    askId: string;
  }
): ReturnType<typeof checkVerbSend> {
  const open = openQuestion(input.pending, input.askId);
  if (!open.ok) {
    return open;
  }
  return checkVerbSend(input);
}
