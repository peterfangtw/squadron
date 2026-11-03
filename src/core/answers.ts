/**
 * Answers to an `AskUserQuestion`, in the one form a session takes one.
 *
 * The ask arrives as a control request on the session's own pipe and the answer
 * goes back as one response with labels in it. Nothing is refused and nothing
 * has to be audited afterwards, because a response is acknowledged.
 *
 * There used to be a second form — a burst of digits and tabs typed at a widget
 * on a screen, plus the machinery to work out afterwards whether it landed on
 * what the reader picked. That went with the rest of the keystroke path;
 * `docs/reference/cli_state/claude/retired.md` keeps the record of what the widget's
 * keys were, since nothing here does any more.
 *
 * `vscode`-free on purpose, and tested: what a label means to the CLI is the
 * one thing here that can be wrong without anything else noticing.
 */

import type { PendingRequest } from './live';
import type { Decision } from './model';
import type { AnsweredAsk } from './transcript';

/**
 * The picks as the tool itself takes them, for a session we own.
 *
 * `AskUserQuestion.call()` renders and decides nothing — it echoes
 * `input.answers` back to the model — so answering is one control response
 * carrying labels, and every shape the keystroke path refuses is ordinary here:
 * multi-select in any slot, more than nine options, several questions at once.
 *
 * Keyed by the **full question text**, matching the CLI's own
 * `mapToolResultToToolResultBlockParam`; a wrong key is silently unanswered. A
 * multi-select's value is an **array** — the CLI joins it itself, observed
 * without a space (`"Red,Blue"`), so nothing should join it here.
 *
 * Only the answers: `updatedInput` is the tool's whole input with these added,
 * so a caller spreads them onto the raw input and a field this repo does not
 * parse survives the round trip.
 *
 * A pick that indexes nothing is dropped and a question left with none gets no
 * key — the same tolerance `expectedAnswers` has. Refusing the whole ask over
 * one bad index is the keystroke path's rule, where a wrong index types into a
 * live session; here it addresses a label by name or does nothing.
 *
 * **`texts[i]` is what was typed under question `i`, and this is the one place
 * the rule for it is stated** — `Decision` and `RequestDecision` point back here
 * rather than restating it.
 *
 * It is the panel's own `Other`, drawn as the CLI draws it: a row of the same
 * option list, picked like any other. So the text is an *answer*, not a note
 * beside one — the tool validates nothing against the labels.
 *
 * The row's mark decides how the two combine. A **single-select**'s row is a
 * radio, so picking it clears the picks and the two never arrive together; a
 * caller sending both is answering one key twice, and the pick wins. A
 * **multi-select**'s is a checkbox, so the text is one more entry in the array,
 * last.
 *
 * Blank is absent: the trim below makes `''`, `'  '` and a missing entry the
 * same thing.
 */
export function answerPayload(
  questions: PendingQuestion[],
  picks: number[][],
  texts: string[] = []
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  questions.forEach((question, i) => {
    const labels = (picks[i] ?? [])
      .map((pick) => question.options[pick]?.label)
      .filter((label): label is string => label !== undefined);
    const typed = texts[i]?.trim();
    if (question.multiSelect) {
      const all = typed ? [...labels, typed] : labels;
      if (all.length) {
        answers[question.question] = all;
      }
      return;
    }
    const first = labels[0] ?? typed;
    if (first !== undefined && first !== '') {
      answers[question.question] = first;
    }
  });
  return answers;
}

/**
 * The notes beside the picks — a word about the choice rather than instead of
 * it, which is the thing `answerPayload` deliberately cannot express.
 *
 * `annotations` rides on `updatedInput` beside `answers`, keyed the same way and
 * with the same silent failure: a key the CLI does not recognise is dropped, and
 * so is the note. Probed 2026-08-05 on CLI 2.1.220 and written down in
 * `docs/reference/cli_state/claude/protocol.md` — the CLI appends it to the answer line
 * the model reads (`"…"="Staging" notes: only for staging.`), leaving the picked
 * label intact, and takes one on a multi-select as readily as on a single.
 *
 * `notes[i]` is what was typed about question `i`, indexed like `picks`, and it
 * is a different field from `texts` on purpose. `texts` is the panel's `Other`
 * row and is an *answer*; this is a remark about an answer already given. One
 * array each keeps a question able to carry both — pick a label, say why — which
 * one array conflating them could not.
 *
 * `preview` is the CLI's own echo of the chosen option's sample and is not ours
 * to compose; nothing here writes one. Blank is absent, on `answerPayload`'s
 * rule, so a dense array with an empty slot is a question with nothing to say.
 */
/**
 * A record read back the way a reader answered it: what was picked, what was
 * typed, and what was said about it — the inverse of `answerPayload`, and
 * indexed like it rather than keyed by question text.
 *
 * The CLI writes labels, so resolving them to indices is a match against the
 * options this record carries. Three rules, and each is a case where the wrong
 * one would draw an answer nobody gave:
 *
 * - An **exact label match** is a pick. Tried first, so a label that itself
 *   contains `', '` resolves as itself rather than being split.
 * - A **string on a multi-select** matching no label is split on a comma and any
 *   space after it, and taken **only if every part matches** a label. All-or-nothing because a
 *   partial split fabricates: labels `['Fast', 'Slow, but safe']` answered as
 *   `'Fast, Slow, but safe'` splits into three, one matches, and the remainder
 *   would be drawn as words the reader never typed. Measured 2026-08-12: the
 *   panel's own path sends an array (93), the TUI's sends one string (49) — and
 *   **only 31 of those 49 split into labels that all match**. The other 18 are
 *   own words that happen to contain a comma, so a split that took what it
 *   could would invent picks for 18 real answers.
 * - Anything left unmatched is the reader's **own words**, which is what the
 *   `Other` row sends. A label genuinely absent from the options — a record
 *   whose ask was edited under it — lands here too, the same tolerance
 *   `answerPayload` shows going the other way.
 *
 * A question with no key at all yields no picks and no text: 3 records measured
 * are answered in part, and a question nobody answered is drawn as one.
 */
export function readAnswers(record: {
  questions: PendingQuestion[];
  answers: Record<string, string | string[]>;
  annotations: Record<string, { notes?: string }>;
}): { picks: number[][]; texts: string[]; notes: string[] } {
  const picks: number[][] = [];
  const texts: string[] = [];
  const notes: string[] = [];
  record.questions.forEach((question, i) => {
    picks[i] = [];
    texts[i] = '';
    // `hasOwn` and not a bare read: the key is a **question's own text**, which
    // is another program's string, and `constructor` or `toString` reaches
    // `Object.prototype` through a `{}` literal. Observed rather than guarded
    // against in theory — on a multi-select `given.split` throws `TypeError`
    // and takes the whole thread push down with it (`ui/activity.ts` runs
    // inside it), and on a single-select the reader is shown
    // `function Object() { [native code] }` as words they typed.
    const has = (of: object, key: string): boolean => Object.hasOwn(of, key);
    notes[i] = has(record.annotations, question.question)
      ? (record.annotations[question.question]?.notes ?? '')
      : '';
    if (!has(record.answers, question.question)) {
      return;
    }
    const given = record.answers[question.question];
    if (given === undefined) {
      return;
    }
    const labels = question.options.map((o) => o.label);
    // First match wins, so two options sharing a label resolve to one index and
    // the second draws unpicked. Deliberate: it under-draws rather than
    // inventing a pick, and nothing in the CLI's shape forbids a repeated label.
    const at = (label: string): number => labels.indexOf(label);
    const own: string[] = [];
    for (const one of Array.isArray(given) ? given : [given]) {
      const index = at(one);
      if (index >= 0) {
        picks[i]?.push(index);
        continue;
      }
      // The TUI's spelling of a multi-select, and only when the whole of it
      // resolves — see the all-or-nothing rule above.
      const parts = question.multiSelect ? one.split(/,\s*/) : [];
      if (parts.length > 1 && parts.every((part) => at(part) >= 0)) {
        for (const part of parts) {
          picks[i]?.push(at(part));
        }
        continue;
      }
      own.push(one);
    }
    // Joined the way a multi-select's array reads, so two unmatched entries do
    // not silently become one. A single-select can only ever have one.
    texts[i] = own.join(', ');
  });
  return { picks, texts, notes };
}

export function annotationPayload(
  questions: PendingQuestion[],
  notes: string[] = [],
  answers: Record<string, string | string[]> = {}
): Record<string, { notes: string }> {
  const out: Record<string, { notes: string }> = {};
  questions.forEach((question, i) => {
    const note = notes[i]?.trim();
    // A note about a question that ended up unanswered is a note about nothing.
    // `answerPayload` drops a question whose picks index nothing — a stale pick
    // against a re-pushed ask is the reachable way — and this follows it rather
    // than deciding again, so the pair cannot come apart on the wire.
    if (note && question.question in answers) {
      out[question.question] = { notes: note };
    }
  });
  return out;
}

/**
 * What an allowed ask answered, in the shape a record holds it — the type both
 * CLIs' readers mint (`AnsweredAsk`), so the dock draws an ask off a record
 * without knowing which one answered it.
 *
 * Here rather than in either session, because both wrote it identically and
 * every input is already neutral. Nothing for a permission prompt, and nothing
 * for a denial: a denied ask answered no question, and the refusal comes back
 * as an ordinary failed tool result the tee already records.
 *
 * The picks are composed once and spent twice — into this and into the reply
 * the CLI is sent — because two derivations of one answer is how the two copies
 * come to disagree about what was chosen.
 */
export function askRecord(
  request: Pick<PendingRequest, 'ask' | 'questions'>,
  decision: Decision
): AnsweredAsk | undefined {
  if (!request.ask || !decision.allow) {
    return undefined;
  }
  const questions = request.questions ?? [];
  const answers = answerPayload(questions, decision.picks ?? [], decision.texts);
  return { questions, answers, annotations: annotationPayload(questions, decision.notes, answers) };
}
