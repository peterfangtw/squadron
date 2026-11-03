import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoAllow, parsePermission, permissionPayload } from '../../core/grok/permissions';

/** Captured 2026-08-17, `grok --permission-mode default agent --no-leader stdio`. */
const captured = {
  sessionId: '01a00dee-920c-7f43-ab0a-dd3b0eee3e0f',
  toolCall: {
    toolCallId: 'call-write-1',
    kind: 'edit',
    title: 'Write `/tmp/av-grok-perm-probe-20260817/workspace/write-allow-once/probe-write.txt`',
    rawInput: {
      variant: 'Write',
      file_path: '/tmp/av-grok-perm-probe-20260817/workspace/write-allow-once/probe-write.txt',
      content: 'hello\n'
    }
  },
  options: [
    {
      optionId: 'allow-edits-session',
      name: 'Yes, allow all edits during this session',
      kind: 'allow_always'
    },
    { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
    {
      optionId: 'reject-once',
      name: 'No, and tell Grok what to do differently',
      kind: 'reject_once'
    }
  ]
};

describe('parsePermission', () => {
  it('reads the 1.0.4 write request', () => {
    const parsed = parsePermission(captured);
    assert.ok(parsed);
    assert.equal(parsed.toolName, 'Write');
    assert.match(parsed.label, /probe-write\.txt/);
    assert.equal(parsed.input?.variant, 'Write');
    assert.equal(parsed.choices.once, 'allow-once');
    assert.equal(parsed.choices.reject, 'reject-once');
    assert.equal(parsed.choices.always, 'allow-edits-session');
    assert.equal(parsed.suggestions?.[0]?.where, 'this session only');
    assert.equal(parsed.suggestions?.[0]?.kind, 'allow_always');
  });

  it('reads a shell-shaped toolCall that is not a Write', () => {
    const parsed = parsePermission({
      toolCall: {
        kind: 'execute',
        title: 'Fetch origin and inspect staging tip plus tags',
        rawInput: { variant: 'run_terminal_command', command: 'cd "$(pwd)" && echo hi' }
      },
      options: captured.options
    });
    assert.ok(parsed);
    assert.equal(parsed.toolName, 'run_terminal_command');
    assert.equal(parsed.choices.once, 'allow-once');
  });

  it('falls back to toolCall.kind when variant is absent', () => {
    const parsed = parsePermission({
      ...captured,
      toolCall: { ...captured.toolCall, rawInput: { file_path: '/tmp/x' } }
    });
    assert.equal(parsed?.toolName, 'edit');
  });

  it('drops an unparseable payload rather than a half-rendered prompt', () => {
    assert.equal(parsePermission(null), undefined);
    assert.equal(parsePermission({}), undefined);
    assert.equal(parsePermission({ toolCall: captured.toolCall, options: [] }), undefined);
    assert.equal(
      parsePermission({
        toolCall: { kind: 'edit' },
        options: captured.options
      }),
      undefined
    );
    assert.equal(
      parsePermission({
        ...captured,
        options: [{ optionId: 'allow-once', kind: 'allow_once' }]
      }),
      undefined
    );
  });
});

describe('permissionPayload', () => {
  it('matches the 1.0.4 selected body for once, always, and reject', () => {
    const parsed = parsePermission(captured);
    assert.ok(parsed);
    assert.deepEqual(permissionPayload(parsed.choices, { allow: true }), {
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    });
    assert.deepEqual(permissionPayload(parsed.choices, { allow: true, always: true }), {
      outcome: { outcome: 'selected', optionId: 'allow-edits-session' }
    });
    assert.deepEqual(permissionPayload(parsed.choices, { allow: false, message: 'nope' }), {
      outcome: { outcome: 'selected', optionId: 'reject-once' }
    });
  });

  it('prefers session-always, else once', () => {
    const parsed = parsePermission(captured);
    assert.ok(parsed);
    assert.deepEqual(autoAllow(parsed.choices), { allow: true, always: true });
    const onceOnly = parsePermission({
      ...captured,
      options: captured.options.filter((o) => o.optionId !== 'allow-edits-session')
    });
    assert.ok(onceOnly);
    assert.deepEqual(autoAllow(onceOnly.choices), { allow: true });
  });

  it('does not invent an always option the request did not offer', () => {
    const parsed = parsePermission({
      ...captured,
      options: captured.options.filter((o) => o.optionId !== 'allow-edits-session')
    });
    assert.ok(parsed);
    assert.equal(parsed.choices.always, undefined);
    assert.equal(permissionPayload(parsed.choices, { allow: true, always: true }), undefined);
  });
});
