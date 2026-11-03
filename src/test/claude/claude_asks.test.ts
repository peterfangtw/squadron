import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAnswered, parseQuestions } from '../../core/claude/asks';

/**
 * The narrowing an `AskUserQuestion` goes through on its way to a dialog.
 *
 * The input is another program's, so the interesting cases are the malformed
 * ones: what survives, and what is dropped rather than half-rendered. These
 * used to run through `readPendingAsk`, against files the dialog hook wrote —
 * the hook is gone, the parse is not.
 */
describe('parseQuestions', () => {
  it('keeps a question whole, header, descriptions and all', () => {
    const [q] = parseQuestions([
      {
        question: 'Which way?',
        header: 'Route',
        multiSelect: false,
        options: [{ label: 'Left', description: 'the scenic route' }, { label: 'Right' }]
      }
    ]);
    assert.equal(q?.question, 'Which way?');
    assert.equal(q?.header, 'Route');
    assert.equal(q?.multiSelect, false);
    assert.deepEqual(q?.options, [
      { label: 'Left', description: 'the scenic route', preview: undefined },
      { label: 'Right', description: undefined, preview: undefined }
    ]);
  });

  it('carries multiSelect and each option’s preview', () => {
    const [q] = parseQuestions([
      {
        question: 'Which profile?',
        multiSelect: true,
        options: [
          { label: 'Delta', preview: '||||||----------  52%' },
          { label: 'Echo', preview: 7 }
        ]
      }
    ]);
    assert.equal(q?.multiSelect, true);
    assert.equal(q?.options[0]?.preview, '||||||----------  52%');
    assert.equal(q?.options[1]?.preview, undefined, 'a preview that is not a string is none');
  });

  it('keeps every question of a multi-question ask, in order', () => {
    const questions = parseQuestions([
      { question: 'first', options: [{ label: 'a' }] },
      { question: 'second', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] }
    ]);
    assert.deepEqual(
      questions.map((q) => q.question),
      ['first', 'second']
    );
  });

  it('yields nothing for input that is not a list of questions', () => {
    assert.deepEqual(parseQuestions(undefined), []);
    assert.deepEqual(parseQuestions('not an array'), []);
    assert.deepEqual(parseQuestions([{ header: 'no question text' }]), []);
  });

  it('drops an option with no label, and a question left with none', () => {
    const questions = parseQuestions([
      { question: 'mixed', options: [{ description: 'no label' }, { label: 'kept' }] },
      { question: 'empty', options: [{ description: 'also no label' }] }
    ]);
    assert.equal(questions.length, 1, 'a question with nothing to pick is not a question');
    assert.deepEqual(
      questions[0]?.options.map((o) => o.label),
      ['kept']
    );
  });
});

/**
 * The same questions read back off a transcript, once somebody has answered
 * them. The source is `toolUseResult`, which every tool result carries — so the
 * cases that matter are the ones where this must yield nothing at all.
 */
describe('parseAnswered', () => {
  const record = {
    questions: [
      {
        question: 'Which way?',
        header: 'Route',
        multiSelect: false,
        options: [{ label: 'Left' }, { label: 'Right' }]
      }
    ],
    answers: { 'Which way?': 'Left' },
    annotations: { 'Which way?': { notes: 'only while it stays flat' } }
  };

  it('keeps the questions, the answers and the note', () => {
    const ask = parseAnswered(record);
    assert.equal(ask?.questions[0]?.header, 'Route');
    assert.deepEqual(ask?.answers, { 'Which way?': 'Left' });
    assert.equal(ask?.annotations['Which way?']?.notes, 'only while it stays flat');
  });

  it('carries a multi-select answer as the array it was written as', () => {
    const ask = parseAnswered({
      questions: [{ question: 'Which?', multiSelect: true, options: [{ label: 'Golf' }] }],
      answers: { 'Which?': ['Golf', 'Hotel'] }
    });
    assert.deepEqual(ask?.answers['Which?'], ['Golf', 'Hotel']);
  });

  it('takes a record with no annotations at all', () => {
    const ask = parseAnswered({ questions: record.questions, answers: record.answers });
    assert.deepEqual(ask?.annotations, {}, 'no note is an empty record, not a missing one');
  });

  it('keeps only the note off an annotation, never the CLI’s preview echo', () => {
    // 116 of 166 annotations measured carry `preview` and no `notes`. The
    // sample is already on the option it belongs to; only the note was typed.
    const ask = parseAnswered({
      questions: record.questions,
      answers: record.answers,
      annotations: { 'Which way?': { preview: 'Left\n||||----  40%' } }
    });
    assert.deepEqual(ask?.annotations, {}, 'a preview is not a note');
  });

  it('yields nothing for a result that is not an answered ask', () => {
    assert.equal(parseAnswered(undefined), undefined);
    assert.equal(parseAnswered('a Bash tool’s output'), undefined);
    assert.equal(parseAnswered({ filenames: ['a.ts'], numFiles: 1 }), undefined, 'a Read');
    assert.equal(parseAnswered({ questions: record.questions }), undefined, 'no answers');
    assert.equal(parseAnswered({ answers: record.answers }), undefined, 'no questions');
  });

  it('yields nothing when every question was dropped', () => {
    assert.equal(
      parseAnswered({ questions: [{ question: 'nothing to pick', options: [] }], answers: {} }),
      undefined
    );
  });
});
