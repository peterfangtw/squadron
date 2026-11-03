import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptedPayload, parseAsk } from '../../core/grok/asks';

const captured = {
  sessionId: '01a00adb-2639-7542-88b1-be104f38339d',
  toolCallId: 'call-05f2f3f1-64a5-40fe-a17f-5ad50b51636e-0',
  questions: [
    {
      question: 'Which route should we take?',
      options: [
        { label: 'Left', description: 'go left' },
        { label: 'Right', description: 'go right' }
      ],
      multiSelect: false
    },
    {
      question: 'Which pace?',
      options: [{ label: 'Slow' }, { label: 'Steady' }, { label: 'Fast' }],
      multiSelect: true
    }
  ],
  mode: 'default'
};

describe('parseAsk', () => {
  it('reads the 1.0.4 request, including snake_case multi_select', () => {
    const [single, multi] = captured.questions;
    assert.ok(single && multi);
    const questions = parseAsk({
      ...captured,
      questions: [single, { ...multi, multiSelect: undefined, multi_select: true }]
    });
    assert.equal(questions.length, 2);
    assert.equal(questions[0]?.question, 'Which route should we take?');
    assert.equal(questions[0]?.multiSelect, false);
    assert.equal(questions[0]?.options[0]?.description, 'go left');
    assert.equal(questions[1]?.multiSelect, true);
  });

  it('drops an unparseable payload rather than a half-rendered ask', () => {
    const [single] = captured.questions;
    assert.ok(single);
    assert.deepEqual(parseAsk(null), []);
    assert.deepEqual(parseAsk({ questions: [{ question: 'Empty', options: [] }] }), []);
    assert.deepEqual(parseAsk({ questions: 'nope' }), []);
    assert.deepEqual(parseAsk({ questions: [single, { question: 'Empty', options: [] }] }), []);
  });
});

describe('acceptedPayload', () => {
  it('matches the 1.0.4 accepted body, including Other text', () => {
    const questions = parseAsk(captured);
    assert.deepEqual(acceptedPayload(questions, { allow: true, picks: [[0], [0]] }), {
      outcome: 'accepted',
      answers: {
        'Which route should we take?': 'Left',
        'Which pace?': ['Slow']
      }
    });
    assert.deepEqual(
      acceptedPayload(questions, {
        allow: true,
        picks: [[], [0]],
        texts: ['Neither — take the canal']
      }),
      {
        outcome: 'accepted',
        answers: {
          'Which route should we take?': 'Neither — take the canal',
          'Which pace?': ['Slow']
        }
      }
    );
  });

  it('does not serialize a denial this sitting', () => {
    assert.equal(
      acceptedPayload(parseAsk(captured), { allow: false, message: 'later' }),
      undefined
    );
  });
});
