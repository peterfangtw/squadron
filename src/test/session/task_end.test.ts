import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { taskEndLines } from '../../core/task_end';
import { MAX_OUTPUT } from '../../core/transcript';

const at = Date.parse('2026-10-13T05:08:00.000Z');

describe('taskEndLines', () => {
  it('folds the end onto its call and marks the turn the CLI starts for it', () => {
    assert.deepEqual(
      taskEndLines({
        call: 'toolu_1',
        cause: 'command',
        status: 'completed',
        output: 'probe-done\n',
        wakes: true,
        at
      }),
      [
        { ret: [{ id: 'toolu_1', output: 'probe-done' }] },
        { mark: 'trigger', trigger: 'task', status: 'completed', at }
      ]
    );
  });

  it('writes no marker when no turn follows', () => {
    assert.deepEqual(
      taskEndLines({
        cause: 'command',
        call: 'call_1',
        status: 'failed',
        output: 'boom',
        wakes: false,
        at
      }),
      [{ ret: [{ id: 'call_1', output: 'boom' }] }]
    );
  });

  it('carries each status as stated, and none when the CLI stated none', () => {
    for (const status of ['completed', 'failed', 'stopped'] as const) {
      assert.deepEqual(taskEndLines({ cause: 'command', call: 'c', status, wakes: true, at })[1], {
        mark: 'trigger',
        trigger: 'task',
        status,
        at
      });
    }
    assert.deepEqual(taskEndLines({ cause: 'command', call: 'c', wakes: true, at })[1], {
      mark: 'trigger',
      trigger: 'task',
      at
    });
  });

  it('never marks the call failed, whatever the status', () => {
    const [ret] = taskEndLines({
      cause: 'command',
      call: 'c',
      status: 'failed',
      output: 'x',
      wakes: false,
      at
    });
    assert.ok(ret && 'ret' in ret);
    assert.equal(ret.ret[0]?.failed, undefined);
  });

  it('overwrites the running notice with an empty output when nothing was printed', () => {
    for (const output of [undefined, '', '  \n']) {
      assert.deepEqual(taskEndLines({ cause: 'command', call: 'c', output, wakes: false, at }), [
        { ret: [{ id: 'c', output: '' }] }
      ]);
    }
  });

  it('cuts the output to the ceiling every reader shares', () => {
    const [ret] = taskEndLines({
      cause: 'command',
      call: 'c',
      output: 'x'.repeat(500),
      wakes: false,
      at
    });
    assert.ok(ret && 'ret' in ret);
    assert.equal(ret.ret[0]?.output, 'x'.repeat(MAX_OUTPUT) + '…');
  });

  it('marks an agent that woke the session as an agent, not a command', () => {
    assert.deepEqual(
      taskEndLines({
        call: 'toolu_agent',
        cause: 'agent',
        status: 'completed',
        output: 'done',
        wakes: true,
        at
      }),
      [
        { ret: [{ id: 'toolu_agent', output: 'done' }] },
        { mark: 'trigger', trigger: 'agent', status: 'completed', at }
      ]
    );
  });

  it('marks a wake whose call lives in another conversation, with nothing on a call', () => {
    for (const cause of ['command', 'agent'] as const) {
      assert.deepEqual(taskEndLines({ cause, status: 'completed', output: 'x', wakes: true, at }), [
        { mark: 'trigger', trigger: cause === 'agent' ? 'agent' : 'task', status: 'completed', at }
      ]);
    }
  });

  it('writes nothing for an end with no call that starts no turn', () => {
    assert.deepEqual(taskEndLines({ cause: 'command', output: 'x', wakes: false, at }), []);
  });
});
