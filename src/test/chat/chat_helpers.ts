import type { TestContext } from 'node:test';
import { openThread, threadView, type Panel } from '../harness';

/** A session reference as a card's copy writes it. */
export const sessionRef = '@squadron[6085][/t/d6913539.jsonl]';

/** What a model pick sends: its name, then the spawn flags that name it. */
export const sonnetPick =
  'a peer on Sonnet 5.5 200k (squadron-spawn --brand claude --model-id claude-sonnet-5-5 --context 200000)';

/** A turn the reader, or the peer `from` names, sent and the transcript holds. */
export const settledTurn = (text: string, from?: string): ExchangeView => ({
  role: 'user',
  text,
  blocks: [{ prose: text }],
  ...(from ? { from } : {})
});

export const userTurnBody = (p: Panel) =>
  p.window.document.querySelector('#thread .turn.user .body');

/** A busy session with `text` held in its outbox. */
export const openQueued = (t: TestContext, text: string): Panel =>
  openThread(t, threadView({ status: 'busy', queued: [{ id: 'q1', text }] }));

export const outboxBody = (p: Panel) => p.window.document.querySelector('#thread .outbox .body');
