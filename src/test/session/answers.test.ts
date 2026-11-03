import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { annotationPayload, answerPayload, readAnswers } from '../../core/answers';

const question = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
  question: 'Which way?',
  multiSelect: false,
  options: [{ label: 'Left' }, { label: 'Right' }, { label: 'Straight on' }],
  ...over
});

/** `n` labelled options, for the digit ceiling. */
const options = (n: number): QuestionOption[] =>
  Array.from({ length: n }, (_, i) => ({ label: 'opt ' + i }));

describe('answerPayload', () => {
  const fruit = question({
    question: 'Which fruit?',
    options: [{ label: 'Fig' }, { label: 'Plum' }]
  });
  const colours = question({
    question: 'Which colours?',
    multiSelect: true,
    options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
  });

  it('keys answers by the full question text', () => {
    // What the CLI's own lookup uses. A wrong key is silently unanswered.
    const answers = answerPayload([fruit], [[1]]);
    assert.deepEqual(answers, { 'Which fruit?': 'Plum' });
  });

  it('leaves a multi-select as an array', () => {
    // The CLI joins it for the model itself, and observed joining it without a
    // space — so nothing here should join it, and nothing downstream should
    // compare against a separator.
    const answers = answerPayload([colours], [[0, 2]]);
    assert.deepEqual(answers, { 'Which colours?': ['Red', 'Green'] });
    assert.deepEqual(answerPayload([colours], [[1]]), { 'Which colours?': ['Blue'] });
  });

  it('answers the shapes the keystroke path refused outright', () => {
    // A multi-select before the last question, and more than nine options:
    // both were unanswerable while an answer was a burst of digits addressed by
    // position, and both are ordinary to a response addressed by request id.
    const many = question({ question: 'Which one?', options: options(12) });
    const answers = answerPayload([colours, fruit, many], [[1], [0], [10]]);
    assert.deepEqual(answers, {
      'Which colours?': ['Blue'],
      'Which fruit?': 'Fig',
      'Which one?': 'opt 10'
    });
  });

  it('drops a pick that indexes nothing, and a question left with none', () => {
    // Tolerant on purpose: a pick here addresses a label by name, so a bad
    // index answers nothing rather than picking the wrong thing.
    const answers = answerPayload([fruit, colours], [[7], [0, 9]]);
    assert.deepEqual(answers, { 'Which colours?': ['Red'] });
  });

  it('answers in the reader’s own words when nothing was picked', () => {
    // The widget's `Other` row, as a field rather than a row: the tool echoes
    // `input.answers` back to the model and validates nothing against the
    // labels, so a string that was never an option is an ordinary answer.
    const answers = answerPayload([fruit], [[]], ['A quince, actually']);
    assert.deepEqual(answers, { 'Which fruit?': 'A quince, actually' });
  });

  it('sends a typed multi-select answer as the array that key takes', () => {
    const answers = answerPayload([colours], [[]], ['Puce']);
    assert.deepEqual(answers, { 'Which colours?': ['Puce'] });
  });

  it('adds a typed multi-select answer to the picks beside it', () => {
    // `Other` is one more ticked box there, so it is one more entry in the
    // array — last, after the labels, in the order the rows were listed.
    const answers = answerPayload([colours], [[0, 2]], ['Puce']);
    assert.deepEqual(answers, { 'Which colours?': ['Red', 'Green', 'Puce'] });
  });

  it('lets a pick beat the text on a single-select', () => {
    // Unreachable from the panel — the `Other` row is a radio row and clears
    // the picks — and tolerated here rather than sending two answers to a
    // question whose key takes one.
    const answers = answerPayload([fruit], [[0]], ['but only a ripe one']);
    assert.deepEqual(answers, { 'Which fruit?': 'Fig' });
  });

  it('ignores an empty or whitespace box', () => {
    assert.deepEqual(answerPayload([fruit], [[]], ['']), {});
    assert.deepEqual(answerPayload([fruit], [[]], ['  \n ']), {});
    // A box nobody typed in and a box typed empty are the same thing here.
    assert.deepEqual(answerPayload([fruit], [[]], []), {});
    // And trims what it does send, so a stray newline is not the answer.
    assert.deepEqual(answerPayload([fruit], [[]], ['  Quince\n']), {
      'Which fruit?': 'Quince'
    });
  });

  it('mixes typed and picked answers across one ask', () => {
    // Per question, so a three-question ask can answer each the way it suits.
    const answers = answerPayload(
      [fruit, colours, question({ question: 'Why?', options: [{ label: 'Because' }] })],
      [[1], [], []],
      ['', 'Whatever is in season', 'It was on the way']
    );
    assert.deepEqual(answers, {
      'Which fruit?': 'Plum',
      'Which colours?': ['Whatever is in season'],
      'Why?': 'It was on the way'
    });
  });
});

describe('annotationPayload', () => {
  const fruit = question({
    question: 'Which fruit?',
    options: [{ label: 'Fig' }, { label: 'Plum' }]
  });
  const colours = question({
    question: 'Which colours?',
    multiSelect: true,
    options: [{ label: 'Red' }, { label: 'Blue' }]
  });

  /** The answers the notes are about, as `answerPayload` would have built them. */
  const answered = (...keys: string[]): Record<string, string> =>
    Object.fromEntries(keys.map((key) => [key, 'whatever was picked']));

  it('keys notes by the full question text, like the answers beside them', () => {
    // Same lookup, same failure mode: a key the CLI does not recognise is
    // silently dropped, and the note goes with it.
    const notes = annotationPayload([fruit], ['but only a ripe one'], answered('Which fruit?'));
    assert.deepEqual(notes, { 'Which fruit?': { notes: 'but only a ripe one' } });
  });

  it('drops a note about a question the answers left out', () => {
    // The reachable path: an ask re-pushed under the same id with fewer
    // options, against a pick staged for the old list. `answerPayload` drops
    // that question, and a note naming it would annotate nothing.
    const notes = annotationPayload(
      [fruit, colours],
      ['ripe only', 'nothing warm'],
      answered('Which colours?')
    );
    assert.deepEqual(notes, { 'Which colours?': { notes: 'nothing warm' } });
    assert.deepEqual(annotationPayload([fruit], ['ripe only'], {}), {});
  });

  it('notes a multi-select the same way', () => {
    // The TUI's `n` is documented on the preview variant alone; a composed
    // response has no widget, and the CLI took one on both shapes
    // (`docs/reference/cli_state/claude/protocol.md`, 2026-08-05).
    const notes = annotationPayload([colours], ['nothing warm'], answered('Which colours?'));
    assert.deepEqual(notes, { 'Which colours?': { notes: 'nothing warm' } });
  });

  it('omits a question nobody annotated', () => {
    const both = answered('Which fruit?', 'Which colours?');
    const notes = annotationPayload([fruit, colours], ['', 'nothing warm'], both);
    assert.deepEqual(notes, { 'Which colours?': { notes: 'nothing warm' } });
    assert.deepEqual(annotationPayload([fruit, colours], [], both), {});
  });

  it('reads blank and whitespace as no note, and trims what it sends', () => {
    // Same rule as the answers': the array is dense, and an empty slot is how a
    // question with nothing to say holds its place.
    assert.deepEqual(annotationPayload([fruit], ['   \n '], answered('Which fruit?')), {});
    assert.deepEqual(annotationPayload([fruit], ['  ripe only\n'], answered('Which fruit?')), {
      'Which fruit?': { notes: 'ripe only' }
    });
  });

  it('composes no preview, ever', () => {
    // `preview` in an annotation is the CLI's own echo of the chosen option's
    // sample. Composing one here would invent a value the reader never saw.
    const notes = annotationPayload([fruit], ['ripe only'], answered('Which fruit?'));
    assert.deepEqual(Object.keys(notes['Which fruit?'] ?? {}), ['notes']);
  });
});

/**
 * The same knowledge read backwards: labels off a transcript to the indices a
 * dialog marks. What can go wrong here is drawing an answer nobody gave, so
 * every rule that could invent one has a case.
 */
describe('readAnswers', () => {
  const fruit = question({
    question: 'Which fruit?',
    options: [{ label: 'Fig' }, { label: 'Plum' }]
  });
  const colours = question({
    question: 'Which colours?',
    multiSelect: true,
    options: [{ label: 'Red' }, { label: 'Blue' }, { label: 'Green' }]
  });
  const read = (
    questions: PendingQuestion[],
    answers: Record<string, string | string[]>,
    annotations: Record<string, { notes?: string }> = {}
  ) => readAnswers({ questions, answers, annotations });

  it('resolves a label to the index that draws it', () => {
    const { picks, texts } = read([fruit], { 'Which fruit?': 'Plum' });
    assert.deepEqual(picks, [[1]]);
    assert.deepEqual(texts, ['']);
  });

  it('resolves every entry of an array', () => {
    const { picks } = read([colours], { 'Which colours?': ['Red', 'Green'] });
    assert.deepEqual(picks, [[0, 2]]);
  });

  it('splits a multi-select written as one string, when all of it matches', () => {
    // The TUI's spelling — 31 of the 49 strings measured on a multi-select
    // resolve this way, and the other 18 are the case below. `answerPayload`
    // records the CLI joining without the space, so both have to survive.
    assert.deepEqual(read([colours], { 'Which colours?': 'Red, Green' }).picks, [[0, 2]]);
    assert.deepEqual(read([colours], { 'Which colours?': 'Red,Green' }).picks, [[0, 2]]);
  });

  it('takes a partly matching split as words, never as a pick', () => {
    // The case the all-or-nothing rule exists for: one part matches a label and
    // the rest would be drawn as something the reader never typed.
    const commas = question({
      question: 'How?',
      multiSelect: true,
      options: [{ label: 'Fast' }, { label: 'Slow, but safe' }]
    });
    const { picks, texts } = read([commas], { 'How?': 'Fast, Slow, but safe' });
    assert.deepEqual(picks, [[]], 'no part of it is a pick');
    assert.deepEqual(texts, ['Fast, Slow, but safe']);
  });

  it('matches a label containing a comma before it tries to split', () => {
    const commas = question({
      question: 'How?',
      multiSelect: true,
      options: [{ label: 'Fast' }, { label: 'Slow, but safe' }]
    });
    assert.deepEqual(read([commas], { 'How?': 'Slow, but safe' }).picks, [[1]]);
  });

  it('never splits a single-select', () => {
    const { picks, texts } = read([fruit], { 'Which fruit?': 'Fig, Plum' });
    assert.deepEqual(picks, [[]]);
    assert.deepEqual(texts, ['Fig, Plum'], 'a single-select’s comma is words');
  });

  it('takes an answer matching no label as the reader’s own words', () => {
    // 19% of answers measured. The `Other` row is where they were typed and
    // where the replay draws them.
    const { picks, texts } = read([fruit], { 'Which fruit?': 'a quince, actually' });
    assert.deepEqual(picks, [[]]);
    assert.deepEqual(texts, ['a quince, actually']);
  });

  it('carries a pick and own words together off a multi-select', () => {
    const { picks, texts } = read([colours], { 'Which colours?': ['Red', 'puce'] });
    assert.deepEqual(picks, [[0]]);
    assert.deepEqual(texts, ['puce']);
  });

  it('leaves a question nobody answered with neither', () => {
    // 3 records measured are answered in part.
    const { picks, texts, notes } = read([fruit, colours], { 'Which fruit?': 'Fig' });
    assert.deepEqual(picks, [[0], []]);
    assert.deepEqual(texts, ['', '']);
    assert.deepEqual(notes, ['', '']);
  });

  it('reads no answer through Object.prototype', () => {
    // The key is a question's own text, which is another program's string, and
    // a `{}` literal answers `constructor` and `toString` from its prototype.
    // Observed before this guard: on a multi-select `given.split` threw and
    // took the whole thread push with it (`toolView` runs inside it), and on a
    // single-select the reader was shown `function Object() { [native code] }`
    // as words they had typed.
    for (const key of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const one = question({ question: key });
      const many = question({ question: key, multiSelect: true });
      assert.deepEqual(read([one], {}), { picks: [[]], texts: [''], notes: [''] }, key);
      assert.deepEqual(read([many], {}), { picks: [[]], texts: [''], notes: [''] }, key);
      // And the annotations beside them, read with the same key.
      assert.deepEqual(read([one], { [key]: 'Left' }, {}).notes, ['']);
    }
  });

  it('lands a note beside the question it was written about', () => {
    const { notes } = read(
      [fruit, colours],
      { 'Which fruit?': 'Fig' },
      {
        'Which colours?': { notes: 'nothing warm' }
      }
    );
    assert.deepEqual(notes, ['', 'nothing warm']);
  });
});
