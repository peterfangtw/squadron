/** Codex app-server requests in the product's pending-request vocabulary. */

import type { SessionEvent } from '../events';
import { SESSION_ONLY, type Decision, type PermissionSuggestion } from '../model';
import { scrub, scrubbedInput } from '../scrub';
import type { CodexId } from './client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const kept = scrub(value.trim());
  return typeof kept === 'string' && kept ? kept : undefined;
}

function relevant(
  value: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(value, key) && value[key] !== null && value[key] !== undefined) {
      picked[key] = value[key];
    }
  }
  return scrubbedInput(picked) ?? {};
}

export function codexRequestKey(id: CodexId): string {
  return `${typeof id === 'number' ? 'n' : 's'}:${id}`;
}

type Waiting = Extract<SessionEvent, { kind: 'waiting' }>;

export type ParsedCodexRequest = {
  key: string;
  protocolId: CodexId;
  threadId: string;
  turnId: string;
  itemId: string;
  ask: boolean;
  waiting: Waiting;
  response(decision: Decision): Record<string, unknown> | undefined;
};

function scoped(
  id: CodexId,
  value: unknown,
  expectedThread: string,
  expectedTurn?: string
):
  | {
      params: Record<string, unknown>;
      key: string;
      threadId: string;
      turnId: string;
      itemId: string;
    }
  | undefined {
  if (!isRecord(value)) return undefined;
  const threadId = nonempty(value.threadId);
  const turnId = nonempty(value.turnId);
  const itemId = nonempty(value.itemId);
  if (
    !threadId ||
    threadId !== expectedThread ||
    !turnId ||
    (expectedTurn !== undefined && turnId !== expectedTurn) ||
    !itemId
  ) {
    return undefined;
  }
  return { params: value, key: codexRequestKey(id), threadId, turnId, itemId };
}

type DecisionSet = {
  accept: boolean;
  always: boolean;
};

// `availableDecisions` is the CLI prompt's menu, not the server's grammar: it
// omits `decline` and the server still takes it, where `cancel` aborts the
// turn (`cli_state/codex/approvals.md`). So the list decides `always` only.
function commandDecisions(value: unknown): DecisionSet | undefined {
  if (value === null || value === undefined) {
    return { accept: true, always: false };
  }
  if (!Array.isArray(value)) return undefined;
  const words = new Set(value.filter((one): one is string => typeof one === 'string'));
  return { accept: words.has('accept'), always: words.has('acceptForSession') };
}

function sessionSuggestion(kind: string): PermissionSuggestion {
  return { kind, where: SESSION_ONLY, raw: { decision: kind } };
}

function commandRequest(
  id: CodexId,
  value: unknown,
  expectedThread: string,
  expectedTurn?: string
): ParsedCodexRequest | undefined {
  const scope = scoped(id, value, expectedThread, expectedTurn);
  if (!scope) return undefined;
  const { params, ...identity } = scope;
  const decisions = commandDecisions(params.availableDecisions);
  if (!decisions?.accept) return undefined;
  const reason = optional(params.reason);
  const command = optional(params.command);
  const network = isRecord(params.networkApprovalContext)
    ? params.networkApprovalContext
    : undefined;
  const host = network && optional(network.host);
  const label = reason ?? command ?? (host ? `Connect to ${host}` : 'Run a command');
  return {
    ...identity,
    protocolId: id,
    ask: false,
    waiting: {
      kind: 'waiting',
      requestId: scope.key,
      open: true,
      ask: false,
      toolName: network ? 'Network' : 'Command',
      label,
      input: relevant(params, [
        'command',
        'cwd',
        'reason',
        'commandActions',
        'additionalPermissions',
        'networkApprovalContext'
      ]),
      suggestions: decisions.always ? [sessionSuggestion('acceptForSession')] : undefined,
      canDenyReason: false
    },
    response: (decision) => {
      if (!decision.allow) return { decision: 'decline' };
      if (decision.always) {
        return decisions.always ? { decision: 'acceptForSession' } : undefined;
      }
      return { decision: 'accept' };
    }
  };
}

function fileRequest(
  id: CodexId,
  value: unknown,
  expectedThread: string,
  expectedTurn?: string
): ParsedCodexRequest | undefined {
  const scope = scoped(id, value, expectedThread, expectedTurn);
  if (!scope) return undefined;
  const { params, ...identity } = scope;
  const reason = optional(params.reason);
  const root = optional(params.grantRoot);
  return {
    ...identity,
    protocolId: id,
    ask: false,
    waiting: {
      kind: 'waiting',
      requestId: scope.key,
      open: true,
      ask: false,
      toolName: 'Files',
      label: reason ?? (root ? `Write under ${root}` : 'Apply file changes'),
      input: relevant(params, ['reason', 'grantRoot']),
      canDenyReason: false
    },
    response: (decision) => {
      if (!decision.allow) return { decision: 'decline' };
      return decision.always ? undefined : { decision: 'accept' };
    }
  };
}

function permissionsRequest(
  id: CodexId,
  value: unknown,
  expectedThread: string,
  expectedTurn?: string
): ParsedCodexRequest | undefined {
  const scope = scoped(id, value, expectedThread, expectedTurn);
  if (!scope || !isRecord(scope.params.permissions)) return undefined;
  const { params, ...identity } = scope;
  const reason = optional(params.reason);
  const cwd = optional(params.cwd);
  const permissions = params.permissions as Record<string, unknown>;
  return {
    ...identity,
    protocolId: id,
    ask: false,
    waiting: {
      kind: 'waiting',
      requestId: scope.key,
      open: true,
      ask: false,
      toolName: 'Permissions',
      label: reason ?? 'Grant additional permissions',
      input: scrubbedInput({ ...(cwd ? { cwd } : {}), permissions }) ?? {},
      suggestions: [sessionSuggestion('permissionGrant')],
      canDenyReason: false
    },
    response: (decision) => ({
      permissions: decision.allow ? permissions : {},
      scope: decision.allow && decision.always ? 'session' : 'turn'
    })
  };
}

type ParsedQuestion = { id: string; view: PendingQuestion };

function question(value: unknown): ParsedQuestion | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonempty(value.id);
  const text = nonempty(value.question);
  if (
    !id ||
    !text ||
    (value.isOther !== undefined && typeof value.isOther !== 'boolean') ||
    (value.isSecret !== undefined && typeof value.isSecret !== 'boolean') ||
    value.isSecret === true
  ) {
    return undefined;
  }
  const canOther = value.isOther === true;
  const options: QuestionOption[] = [];
  if (value.options !== null && value.options !== undefined) {
    if (!Array.isArray(value.options)) return undefined;
    for (const raw of value.options) {
      const label = isRecord(raw) ? nonempty(raw.label) : undefined;
      if (!label || (raw.description != null && typeof raw.description !== 'string')) {
        return undefined;
      }
      options.push({
        label,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {})
      });
    }
  }
  if (!options.length && !canOther) return undefined;
  return {
    id,
    view: {
      question: text,
      header: optional(value.header),
      multiSelect: false,
      canOther,
      options
    }
  };
}

function questionRequest(
  id: CodexId,
  value: unknown,
  expectedThread: string,
  expectedTurn?: string
): ParsedCodexRequest | undefined {
  const scope = scoped(id, value, expectedThread, expectedTurn);
  // `isBlocking` says whether Codex will wait, not whether the reader was
  // asked, so a `false` is a question like any other — refusing it answered a
  // valid question with `-32602`, which app-server converts to `{answers:{}}`
  // and resumes on (`cli_state/codex/protocol.md`). Arm C reached exactly that
  // frame from an ordinary panel thread with the feature set in `config.toml`.
  // The type is still checked: 0.153.2 declares it a required boolean, and
  // admitting a string or object here would widen malformed-frame policy, which
  // this change deliberately leaves alone.
  const blocking = scope?.params.isBlocking;
  if (
    !scope ||
    (blocking !== undefined && typeof blocking !== 'boolean') ||
    !Array.isArray(scope.params.questions) ||
    !scope.params.questions.length
  ) {
    return undefined;
  }
  const { params, ...identity } = scope;
  const parsed = (params.questions as unknown[]).map(question);
  if (parsed.some((row) => row === undefined)) return undefined;
  const rows = parsed as ParsedQuestion[];
  return {
    ...identity,
    protocolId: id,
    ask: true,
    waiting: {
      kind: 'waiting',
      requestId: scope.key,
      open: true,
      ask: true,
      questions: rows.map((row) => row.view),
      // Notes ride as a second `user_note:` member of the same answer array,
      // which the encoder below already writes; `canReply` has no arm in
      // `ToolRequestUserInputResponse` at all.
      canReply: false
    },
    response: (decision) => {
      if (!decision.allow) return undefined;
      const entries: [string, { answers: string[] }][] = [];
      for (const [index, row] of rows.entries()) {
        const picked = decision.picks?.[index] ?? [];
        const typed = decision.texts?.[index]?.trim();
        // Only a malformed pick is refused. Picks and typed text arriving
        // together is a caller answering one key twice, and `answers.ts` states
        // for every brand that the pick wins — refusing instead would leave the
        // dialog open with nothing able to close it.
        if (picked.length > 1) return undefined;
        const answer = picked.length ? row.view.options[picked[0] ?? -1]?.label : typed;
        if (!answer || (!picked.length && row.view.canOther === false)) return undefined;
        // Both literals are the TUI's own, read at `rust-v0.151.0` in
        // `request_user_input`'s `submit_answers`: a remark rides as a second
        // member `user_note: <text>`, and typed Other keeps the label `None of
        // the above` in front of it. App-server passes the strings through
        // unchanged, so bare text arrives as an option label the question never
        // offered — accepted, but no first-party producer's form.
        const answers = picked.length ? [answer] : ['None of the above', `user_note: ${answer}`];
        const note = picked.length ? decision.notes?.[index]?.trim() : undefined;
        if (note) answers.push(`user_note: ${note}`);
        entries.push([row.id, { answers }]);
      }
      return { answers: Object.fromEntries(entries) };
    }
  };
}

type RequestParser = (
  id: CodexId,
  params: unknown,
  expectedThread: string,
  expectedTurn?: string
) => ParsedCodexRequest | undefined;

const REQUEST_PARSERS: Record<string, RequestParser> = {
  'item/commandExecution/requestApproval': commandRequest,
  'item/fileChange/requestApproval': fileRequest,
  'item/permissions/requestApproval': permissionsRequest,
  'item/tool/requestUserInput': questionRequest
};

export function isCodexRequestMethod(method: string): boolean {
  return Object.hasOwn(REQUEST_PARSERS, method);
}

export function parseCodexRequest(
  id: CodexId,
  method: string,
  params: unknown,
  expectedThread: string,
  expectedTurn?: string
): ParsedCodexRequest | undefined {
  if (!isCodexRequestMethod(method)) return undefined;
  return REQUEST_PARSERS[method]?.(id, params, expectedThread, expectedTurn);
}

export function resolvedCodexRequest(value: unknown, expectedThread: string): string | undefined {
  if (!isRecord(value) || value.threadId !== expectedThread) return undefined;
  const id = value.requestId;
  return typeof id === 'string' || typeof id === 'number' ? codexRequestKey(id) : undefined;
}
