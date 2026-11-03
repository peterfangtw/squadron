import * as assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { tempHome } from '../helpers';

type Delivery = typeof import('../../core/delivery');
type Workflows = typeof import('../../core/workflows/workflows');
type Progress = typeof import('../../core/workflows/progress');
type Claude = typeof import('../../core/claude/session');
type Frame = {
  type?: string;
  message?: { content?: { type?: string; text?: string }[] };
};

let delivery: Delivery;
let wf: Workflows;
let progress: Progress;
let claude: Claude;
let nowhere = '';

const alive: InstanceType<Claude['OwnedSession']>[] = [];

/**
 * `paths.ts` resolves `~/.claude` when it is first required, so `HOME` moves
 * before the session handle is imported. The cwd has to sit outside a
 * repository: a drain baselines the working tree, and this checkout is not a
 * tree a unit test should stage.
 */
before(async () => {
  nowhere = await tempHome();
  delivery = await import('../../core/delivery');
  wf = await import('../../core/workflows/workflows');
  progress = await import('../../core/workflows/progress');
  claude = await import('../../core/claude/session');
});

after(() => {
  for (const session of alive) session.close();
});

const named = { label: 'Ship it', id: 'ship-it' };

/**
 * What the child was written, once the outbox has drained.
 *
 * `hold` starts a turn first, so the send sits in the outbox and the idle
 * edge is what writes it — a message held while a session is busy.
 */
async function textOnTheWire(text: string, hold = false): Promise<string> {
  const written: Frame[] = [];
  const lines: ((value: unknown) => void)[] = [];
  const session = new claude.OwnedSession(
    {
      pid: 4242,
      write: (value) => written.push(value as Frame),
      onLine: (listener) => lines.push(listener),
      onExit: () => undefined,
      close: () => undefined
    },
    { cwd: nowhere, startedAt: 1000 }
  );
  alive.push(session);
  const answer = (line: unknown): void => {
    for (const listener of lines) listener(line);
  };
  if (hold) {
    answer({
      type: 'stream_event',
      event: { type: 'message_start', message: { model: 'claude-opus-5' } }
    });
    session.send(text);
    assert.equal(session.state.queued[0]?.text, text);
    answer({ type: 'result' });
  } else {
    session.send(text);
  }
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const frame = written.find((item) => item.type === 'user');
    const block = frame?.message?.content?.find((part) => part.type === 'text');
    if (session.state.queued.length === 0 && block?.text !== undefined) return block.text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`nothing reached the session; wrote ${JSON.stringify(written)}`);
}

describe('deliveryText', () => {
  it('sends a plain body with its leading spaces and leading blank lines', async () => {
    const body = '  \n\nhello';
    assert.equal(delivery.deliveryText(body), body);
    assert.equal(await textOnTheWire(body), body);
  });

  it('sends a held retry with its leading spaces and leading blank lines', async () => {
    // The retry resubmits the captured delivery. The same bytes, held while a
    // turn is running, are what the idle edge writes.
    const held = '\n\n  held';
    assert.equal(delivery.deliveryText(held), held);
    assert.equal(await textOnTheWire(held, true), held);
  });

  it('sends a workflow-enriched body with the subject’s leading whitespace', async () => {
    const subject = '\n\n  hello';
    const enriched = wf.enrich(named, subject);
    const briefed = progress.withProgressBriefing(enriched, '/runs/sess.progress.json', 'posix');
    assert.ok(enriched.endsWith(`\n\n${subject}`));
    assert.ok(briefed.includes(`\n\n${subject}\n\n`));
    assert.equal(delivery.deliveryText(briefed), briefed);
    assert.equal(await textOnTheWire(briefed), briefed);
  });

  it('sends no text for a body that is only whitespace', () => {
    // An image beside a blank box goes alone: a text block of whitespace is
    // not what the reader wrote.
    assert.equal(delivery.deliveryText(''), '');
    assert.equal(delivery.deliveryText(' \n\t'), '');
    assert.equal(wf.enrich(named, ' \n '), 'Following the workflow "Ship it" (ship-it).');
  });
});
