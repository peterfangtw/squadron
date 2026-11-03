import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { Outbound } from '../../core/claude/frames';
import { askModels, listModels } from '../../core/claude/models';
import { ExitInfo, SessionTransport } from '../../core/session';
import { outRoot } from '../helpers';
import * as executables from '../../core/platform/executables';

/** The same fake CLI `claude_session.test.ts` drives, spawned through the real
 *  transport — so what is under test is the round trip, not a parse of a
 *  literal we wrote in this file. */
const FAKE = path.join(outRoot(), 'test', 'fixtures', 'fake-cli.js');

/** A pipe with nobody on the other end, so an answer can be withheld, malformed
 *  or replaced by an exit. */
function stub(): {
  transport: SessionTransport;
  written: Outbound[];
  closed: () => number;
  answer: (line: Record<string, unknown>) => void;
  exit: () => void;
} {
  const written: Outbound[] = [];
  const lines: ((value: unknown) => void)[] = [];
  const exits: ((info: ExitInfo) => void)[] = [];
  let closes = 0;
  return {
    written,
    closed: () => closes,
    answer: (line) => lines.forEach((listener) => listener(line)),
    exit: () => exits.forEach((listener) => listener({ code: 1, signal: null, source: 'exit' })),
    transport: {
      write: (value) => written.push(value as Outbound),
      onLine: (listener) => lines.push(listener),
      onExit: (listener) => exits.push(listener),
      close: () => {
        closes++;
      }
    }
  };
}

/** One line as the CLI would put it on stdout — the wire spelling, since the
 *  answer goes through `readFrame` on its way in now. */
const response = (requestId: string, models: unknown): Record<string, unknown> => ({
  type: 'control_response',
  response: { subtype: 'success', request_id: requestId, response: { models } }
});

describe('models', () => {
  it('asks a fresh child and maps what it answers', async () => {
    const models = await listModels(executables.named(FAKE, process.execPath), process.cwd());
    assert.deepEqual(models, [
      { value: 'opus[1m]', name: 'Opus (1M context)', id: 'claude-opus-5[1m]', brand: 'claude' },
      { value: 'claude-fable-5[1m]', name: 'Fable', id: 'claude-fable-5', brand: 'claude' },
      { value: 'haiku', name: 'Haiku', id: 'claude-haiku-4-5-20251001', brand: 'claude' }
    ]);
  });

  /**
   * The update nag, which is not a model. An out-of-date binary answers with a
   * `disabled: true` row whose `value` is `cc-update-required-1` and whose
   * `displayName` is the model it is refusing to run — observed 2026-09-02 on
   * 2.1.241, listing `Fable 5.1 (disabled)`. Passing it through made
   * `models.mjs` report the catalog was missing a row for a placeholder.
   */
  it('drops a row the CLI marks disabled', async () => {
    const models = await listModels(executables.named(FAKE, process.execPath), process.cwd());
    assert.equal(
      models.some((m) => m.value === 'cc-update-required-1'),
      false
    );
  });

  it('drops the CLI’s own default row', async () => {
    const models = await listModels(executables.named(FAKE, process.execPath), process.cwd());
    assert.equal(
      models.some((m) => m.value === 'default'),
      false
    );
  });

  it('asks once, as a control request, and closes the pipe after', async () => {
    const rig = stub();
    const answer = askModels(rig.transport);
    assert.deepEqual(rig.written, [
      {
        type: 'control_request',
        request_id: 'squadron-models',
        request: { subtype: 'list_models' }
      }
    ]);
    rig.answer(response('squadron-models', []));
    await answer;
    assert.equal(rig.closed(), 1);
  });

  it('ignores a response to someone else’s request', async () => {
    const rig = stub();
    const answer = askModels(rig.transport);
    rig.answer(response('other', [{ value: 'haiku', displayName: 'Haiku' }]));
    rig.answer(response('squadron-models', [{ value: 'sonnet', displayName: 'Sonnet' }]));
    assert.deepEqual(await answer, [{ value: 'sonnet', name: 'Sonnet', id: '', brand: 'claude' }]);
  });

  it('answers nothing rather than throwing when the CLI refuses', async () => {
    const rig = stub();
    const answer = askModels(rig.transport);
    rig.answer({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'squadron-models', error: 'no' }
    });
    assert.deepEqual(await answer, []);
  });

  it('answers nothing when the child dies before saying anything', async () => {
    const rig = stub();
    const answer = askModels(rig.transport);
    rig.exit();
    assert.deepEqual(await answer, []);
  });

  it('skips a row with no value, and falls back to it for a row with no name', async () => {
    const rig = stub();
    const answer = askModels(rig.transport);
    rig.answer(
      response('squadron-models', [
        { resolvedModel: 'claude-nameless', displayName: 'Nameless' },
        { value: 'sonnet' },
        'not an object'
      ])
    );
    assert.deepEqual(await answer, [{ value: 'sonnet', name: 'sonnet', id: '', brand: 'claude' }]);
  });

  it('answers nothing when the payload is not a list', async () => {
    const rig = stub();
    const answer = askModels(rig.transport);
    rig.answer(response('squadron-models', undefined));
    assert.deepEqual(await answer, []);
  });
});
