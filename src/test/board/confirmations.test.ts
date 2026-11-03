import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Confirmations } from '../../ui/confirmations';

const view: ConfirmationView = {
  title: 'End session?',
  detail: 'The transcript is kept.',
  actions: [{ id: 'end', label: 'End session', destructive: true }]
};

describe('confirmation answers', () => {
  it('accepts only an offered action for the current request, once', async () => {
    const sent: ConfirmModalMessage[] = [];
    const confirmations = new Confirmations((message) => sent.push(message));
    const first = confirmations.ask(view);
    const id = sent[0]!.requestId;
    confirmations.answer('different-request', 'end');
    confirmations.answer(id, 'end');
    assert.equal(await first, 'end');
    const second = confirmations.ask(view);
    assert.notEqual(sent[1]!.requestId, id);
    confirmations.answer(id, 'end');
    confirmations.answer(sent[1]!.requestId);
    assert.equal(await second, undefined);
  });

  it('an unoffered action cancels rather than authorizing work', async () => {
    const sent: ConfirmModalMessage[] = [];
    const confirmations = new Confirmations((message) => sent.push(message));
    const answer = confirmations.ask(view);
    confirmations.answer(sent[0]!.requestId, 'all');
    assert.equal(await answer, undefined);
  });

  it('replacement, document reload and disposal release pending questions without action', async () => {
    const sent: ConfirmModalMessage[] = [];
    const confirmations = new Confirmations((message) => sent.push(message));
    const first = confirmations.ask(view);
    const second = confirmations.ask(view);
    assert.equal(await first, undefined);
    confirmations.cancel();
    assert.equal(await second, undefined);
    const third = confirmations.ask(view);
    confirmations.dispose();
    assert.equal(await third, undefined);
    assert.equal(await confirmations.ask(view), undefined);
    assert.equal(sent.length, 3, 'a disposed panel must not open another dialog');
  });
});
