import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { codexRequestKey, parseCodexRequest, resolvedCodexRequest } from '../../core/codex/asks';
import { repoRoot } from '../helpers';

const FIXTURES = path.join(repoRoot(), 'src', 'test', 'fixtures', 'codex-app-server-0.151.0');

// 0.153.2 is the installed binary. The 0.151.0 reads above still pin the
// evidence they were taken from and are deliberately not repointed here.
const FIXTURES_0153 = path.join(repoRoot(), 'src', 'test', 'fixtures', 'codex-app-server-0.153.2');

const scope = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1'
};

describe('Codex approval requests', () => {
  it('maps only the command decisions the request offered', () => {
    const request = parseCodexRequest(
      7,
      'item/commandExecution/requestApproval',
      {
        ...scope,
        command: 'npm test',
        cwd: '/repo',
        reason: 'Run the suite',
        availableDecisions: ['accept', 'acceptForSession', 'decline']
      },
      'thread-1',
      'turn-1'
    );
    assert.ok(request);
    assert.equal(request.key, 'n:7');
    assert.equal(request.waiting.toolName, 'Command');
    assert.equal(request.waiting.label, 'Run the suite');
    assert.equal(request.waiting.canDenyReason, false);
    assert.equal(request.waiting.suggestions?.[0]?.where, 'this session only');
    assert.deepEqual(request.response({ allow: true }), { decision: 'accept' });
    assert.deepEqual(request.response({ allow: true, always: true }), {
      decision: 'acceptForSession'
    });
    assert.deepEqual(request.response({ allow: false, message: 'not on this branch' }), {
      decision: 'decline'
    });
  });

  it('answers Deny with `decline` whatever the list offers, and invents no always arm', async () => {
    // 0.153.2's own request for an escalated command: `accept`, an execpolicy
    // amendment object and `cancel`, no `decline` — and `decline` is still the
    // answer the server takes (`cli_state/codex/approvals.md`).
    const frames = (await fs.readFile(path.join(FIXTURES_0153, 'command_decline.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { m: { method?: string; id?: number; params?: unknown } });
    const request = frames.find(
      (frame) => frame.m.method === 'item/commandExecution/requestApproval'
    );
    assert.ok(request);
    const once = parseCodexRequest(
      request.m.id ?? 0,
      request.m.method ?? '',
      request.m.params,
      '<thread-1>',
      '<turn-1>'
    );
    assert.ok(once);
    assert.equal(once.waiting.suggestions, undefined);
    assert.equal(once.response({ allow: true, always: true }), undefined);
    assert.deepEqual(once.response({ allow: false }), { decision: 'decline' });
    assert.equal(
      parseCodexRequest(
        1,
        'item/commandExecution/requestApproval',
        { ...scope, command: 'pwd', availableDecisions: ['cancel'] },
        'thread-1'
      ),
      undefined
    );
  });

  it('uses the legacy once/decline pair when an older server omits its optional list', () => {
    const request = parseCodexRequest(
      8,
      'item/commandExecution/requestApproval',
      { ...scope, command: 'pwd' },
      'thread-1'
    );
    assert.ok(request);
    assert.deepEqual(request.response({ allow: true }), { decision: 'accept' });
    assert.deepEqual(request.response({ allow: false }), { decision: 'decline' });
    assert.equal(request.response({ allow: true, always: true }), undefined);
  });

  it('bounds and trims model-authored permission titles', () => {
    const request = parseCodexRequest(
      9,
      'item/commandExecution/requestApproval',
      {
        ...scope,
        reason: `  ${'x'.repeat(500)}  `,
        availableDecisions: ['accept', 'decline']
      },
      'thread-1'
    );
    assert.ok(request);
    assert.equal(request.waiting.label, 'x'.repeat(300));
  });

  it('maps file approval without claiming the unstable grant root persists', () => {
    const request = parseCodexRequest(
      2,
      'item/fileChange/requestApproval',
      { ...scope, reason: null, grantRoot: '/repo/generated' },
      'thread-1'
    );
    assert.ok(request);
    assert.equal(request.waiting.label, 'Write under /repo/generated');
    assert.deepEqual(request.response({ allow: true }), { decision: 'accept' });
    assert.deepEqual(request.response({ allow: false }), { decision: 'decline' });
    assert.equal(request.response({ allow: true, always: true }), undefined);
  });

  it('echoes only the requested permission profile at the chosen scope', () => {
    const permissions = {
      network: { enabled: true },
      fileSystem: { write: ['/repo/shared'] }
    };
    const request = parseCodexRequest(
      3,
      'item/permissions/requestApproval',
      { ...scope, cwd: '/repo', reason: 'Use the shared output', permissions },
      'thread-1'
    );
    assert.ok(request);
    assert.equal(request.waiting.toolName, 'Permissions');
    assert.equal(request.waiting.suggestions?.[0]?.where, 'this session only');
    assert.deepEqual(request.response({ allow: true }), { permissions, scope: 'turn' });
    assert.deepEqual(request.response({ allow: true, always: true }), {
      permissions,
      scope: 'session'
    });
    assert.deepEqual(request.response({ allow: false, message: 'no network' }), {
      permissions: {},
      scope: 'turn'
    });
  });
});

describe('Codex user-input requests', () => {
  const params = {
    ...scope,
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      {
        id: 'q1',
        header: 'Route',
        question: 'Which route?',
        isOther: false,
        isSecret: false,
        options: [
          { label: 'Left', description: 'Scenic' },
          { label: 'Right', description: 'Direct' }
        ]
      },
      {
        id: 'q2',
        header: 'Why',
        question: 'Anything else?',
        isOther: true,
        isSecret: false,
        options: null
      }
    ]
  };

  it('keeps question ids private and uses Codex answer/note encodings', () => {
    const request = parseCodexRequest(
      'ask-1',
      'item/tool/requestUserInput',
      params,
      'thread-1',
      'turn-1'
    );
    assert.ok(request);
    assert.equal(request.key, 's:ask-1');
    assert.equal(request.waiting.ask, true);
    // Unset, not false: the encoder has always written `user_note:`, so the
    // dialog now advertises the field it could already serialize.
    assert.equal(request.waiting.canNote, undefined);
    assert.equal(request.waiting.canReply, false);
    assert.deepEqual(request.waiting.questions, [
      {
        question: 'Which route?',
        header: 'Route',
        multiSelect: false,
        canOther: false,
        options: [
          { label: 'Left', description: 'Scenic' },
          { label: 'Right', description: 'Direct' }
        ]
      },
      {
        question: 'Anything else?',
        header: 'Why',
        multiSelect: false,
        canOther: true,
        options: []
      }
    ]);
    assert.deepEqual(
      request.response({
        allow: true,
        picks: [[1], []],
        texts: ['', 'Wait'],
        notes: [' only for staging ', 'not sent for Other']
      }),
      {
        answers: {
          q1: { answers: ['Right', 'user_note: only for staging'] },
          q2: { answers: ['None of the above', 'user_note: Wait'] }
        }
      }
    );
  });

  it('refuses partial, multi-pick, typed-when-forbidden, and deny responses', () => {
    const request = parseCodexRequest(4, 'item/tool/requestUserInput', params, 'thread-1');
    assert.ok(request);
    assert.equal(request.response({ allow: true, picks: [[0]] }), undefined);
    assert.equal(
      request.response({ allow: true, picks: [[0, 1], []], texts: ['', 'words'] }),
      undefined
    );
    assert.equal(
      request.response({ allow: true, picks: [[], []], texts: ['words', 'more'] }),
      undefined
    );
    assert.equal(request.response({ allow: false, message: 'ask later' }), undefined);
  });

  it('lets the pick win when a malformed decision carries a typed answer too', () => {
    // `answers.ts` states this for every brand: a single-select's row is a
    // radio, so both arriving is one key answered twice. Refusing the whole
    // response instead would leave the dialog open with nothing able to shut it.
    const request = parseCodexRequest(5, 'item/tool/requestUserInput', params, 'thread-1');
    assert.ok(request);
    assert.deepEqual(
      request.response({ allow: true, picks: [[0], []], texts: ['also Other', 'words'] }),
      {
        answers: {
          q1: { answers: ['Left'] },
          q2: { answers: ['None of the above', 'user_note: words'] }
        }
      }
    );
  });

  it('degrades missing descriptions/options into product fields it can represent', () => {
    const request = parseCodexRequest(
      10,
      'item/tool/requestUserInput',
      {
        ...scope,
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: 'pick',
            header: 'Pick',
            question: 'Choose one',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Alpha', description: null }]
          },
          {
            id: 'words',
            header: 'Words',
            question: 'Say it',
            isOther: true,
            isSecret: false
          }
        ]
      },
      'thread-1'
    );
    assert.ok(request);
    assert.deepEqual(request.waiting.questions?.[0]?.options, [{ label: 'Alpha' }]);
    assert.deepEqual(request.waiting.questions?.[1]?.options, []);
  });

  it('defaults omitted protocol booleans to false', () => {
    const request = parseCodexRequest(
      11,
      'item/tool/requestUserInput',
      {
        ...scope,
        isBlocking: true,
        questions: [
          {
            id: 'pick',
            question: 'Choose one',
            options: [{ label: 'Alpha' }]
          }
        ]
      },
      'thread-1'
    );
    assert.ok(request);
    assert.equal(request.waiting.questions?.[0]?.canOther, false);
  });

  it('accepts blocking live frames and the Default-mode non-blocking control', async () => {
    const answers = JSON.parse(
      await fs.readFile(path.join(FIXTURES, 'questions_answers.json'), 'utf8')
    ) as Record<string, { request: { id: number; method: string; params: typeof params } }>;
    // Both loops below are the whole assertion, so an emptied or reshaped
    // fixture must fail here rather than pass over nothing.
    assert.equal(Object.keys(answers).length, 6);
    for (const arm of Object.values(answers)) {
      assert.ok(
        parseCodexRequest(
          arm.request.id,
          arm.request.method,
          arm.request.params,
          arm.request.params.threadId,
          arm.request.params.turnId
        )
      );
    }

    const reachability = JSON.parse(
      await fs.readFile(path.join(FIXTURES, 'questions_reachability.json'), 'utf8')
    ) as { request?: { id: number; method: string; params: typeof params } }[];
    assert.equal(reachability.filter((cell) => cell.request).length, 2);
    for (const cell of reachability) {
      const request = cell.request;
      if (!request) continue;
      assert.ok(
        parseCodexRequest(
          request.id,
          request.method,
          request.params,
          request.params.threadId,
          request.params.turnId
        )
      );
    }
  });

  // Arm C, 2026-09-05: `features.default_mode_request_user_input` in
  // `config.toml` reaches a thread started with no `config` argument, so this
  // frame is what an ordinary panel reader gets. Rejecting it is what made the
  // turn resume on an answer nobody gave.
  it('accepts the live config-file non-blocking request and advertises Notes', async () => {
    const cells = JSON.parse(
      await fs.readFile(path.join(FIXTURES_0153, 'questions_config_file.json'), 'utf8')
    ) as {
      configFileFeature: boolean;
      emitted: boolean;
      request?: { id: number; method: string; params: typeof params };
    }[];
    const emitted = cells.filter((cell) => cell.emitted);
    assert.equal(emitted.length, 1);
    assert.equal(
      cells.some((cell) => !cell.configFileFeature && !cell.emitted),
      true
    );

    const live = emitted[0]?.request;
    assert.ok(live);
    assert.equal(live.params.isBlocking, false);
    const request = parseCodexRequest(
      live.id,
      live.method,
      live.params,
      live.params.threadId,
      live.params.turnId
    );
    assert.ok(request);
    assert.equal(request.waiting.canNote, undefined);
    assert.equal(request.waiting.canReply, false);
    assert.equal(request.waiting.questions?.[0]?.canOther, true);
    assert.deepEqual(request.response({ allow: true, picks: [[0]], texts: [''], notes: ['why'] }), {
      answers: { config: { answers: ['Alpha (Recommended)', 'user_note: why'] } }
    });
  });

  it('fails closed on secret, malformed, and cross-scope requests', () => {
    const one = params.questions[0];
    assert.equal(
      parseCodexRequest(
        5,
        'item/tool/requestUserInput',
        { ...params, questions: [{ ...one, isSecret: true }] },
        'thread-1'
      ),
      undefined
    );
    // `isBlocking: false` is a valid question, not a malformed one — see the
    // config-file arm above. Absent is accepted too: the binding makes the field
    // required, we never echo it, and refusing is what resumed the turn on an
    // answer nobody gave. Both directions are pinned so the gate cannot come
    // back quietly.
    assert.ok(
      parseCodexRequest(
        5,
        'item/tool/requestUserInput',
        { ...params, isBlocking: false },
        'thread-1'
      )
    );
    const { isBlocking: _omitted, ...withoutBlocking } = params;
    assert.ok(parseCodexRequest(5, 'item/tool/requestUserInput', withoutBlocking, 'thread-1'));
    // A non-boolean is still a malformed frame, and malformed policy is
    // unchanged by this slice.
    for (const bad of ['yes', 0, null, {}]) {
      assert.equal(
        parseCodexRequest(
          5,
          'item/tool/requestUserInput',
          { ...params, isBlocking: bad },
          'thread-1'
        ),
        undefined
      );
    }
    assert.equal(
      parseCodexRequest(5, 'item/tool/requestUserInput', { ...params, questions: [] }, 'thread-1'),
      undefined
    );
    assert.equal(
      parseCodexRequest(5, 'item/tool/requestUserInput', params, 'other-thread'),
      undefined
    );
    assert.equal(
      parseCodexRequest(5, 'item/tool/requestUserInput', params, 'thread-1', 'other-turn'),
      undefined
    );
  });
});

describe('Codex request resolution', () => {
  it('distinguishes numeric and string ids and accepts only this thread', () => {
    assert.equal(codexRequestKey(3), 'n:3');
    assert.equal(codexRequestKey('3'), 's:3');
    assert.equal(resolvedCodexRequest({ threadId: 'thread-1', requestId: 3 }, 'thread-1'), 'n:3');
    assert.equal(resolvedCodexRequest({ threadId: 'thread-1', requestId: '3' }, 'thread-1'), 's:3');
    assert.equal(
      resolvedCodexRequest({ threadId: 'thread-2', requestId: 3 }, 'thread-1'),
      undefined
    );
  });
});
