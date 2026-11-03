/**
 * Grok `session/request_permission` → product pending fields, and
 * `Decision` → the 1.0.4 result body.
 *
 * Observed 2026-08-17, isolated cwd
 * `/tmp/av-grok-perm-probe-20260817/workspace`, launch
 * `grok --permission-mode default agent --no-leader stdio`. Result is
 * `{ outcome: { outcome: "selected", optionId } }`. `allow-once` writes
 * the file and `end_turn`. `reject-once` writes nothing,
 * `stopReason: "cancelled"` / `cancellationCategory: "PermissionRejected"`.
 * `allow-edits-session` writes, and a second write in the same session
 * does not re-prompt. No home for a deny message. See
 * `docs/reference/cli_state/grok/protocol.md`.
 */

import { SESSION_ONLY, type Decision, type PermissionSuggestion } from '../model';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type PermissionChoices = {
  once: string;
  reject: string;
  always?: string;
};

export type ParsedPermission = {
  toolName: string;
  label: string;
  input?: Record<string, unknown>;
  suggestions?: PermissionSuggestion[];
  choices: PermissionChoices;
};

function parseOption(raw: unknown): { optionId: string; kind?: string } | undefined {
  if (!isRecord(raw) || typeof raw.optionId !== 'string' || !raw.optionId) {
    return undefined;
  }
  return { optionId: raw.optionId, kind: typeof raw.kind === 'string' ? raw.kind : undefined };
}

/** Product fields + option ids, or nothing. Missing once/reject drops it. */
export function parsePermission(params: unknown): ParsedPermission | undefined {
  if (!isRecord(params) || !isRecord(params.toolCall) || !Array.isArray(params.options)) {
    return undefined;
  }
  const tool = params.toolCall;
  const input = isRecord(tool.rawInput) ? tool.rawInput : undefined;
  const label = typeof tool.title === 'string' && tool.title ? tool.title : undefined;
  const toolName =
    (typeof input?.variant === 'string' && input.variant) ||
    (typeof tool.kind === 'string' && tool.kind) ||
    undefined;
  if (!label || !toolName) {
    return undefined;
  }
  let once: string | undefined;
  let reject: string | undefined;
  let always: string | undefined;
  let alwaysRaw: Record<string, unknown> | undefined;
  for (const raw of params.options) {
    const option = parseOption(raw);
    if (!option) {
      return undefined;
    }
    if (option.kind === 'allow_once' || option.optionId === 'allow-once') {
      once = option.optionId;
    } else if (option.kind === 'reject_once' || option.optionId === 'reject-once') {
      reject = option.optionId;
    } else if (option.kind === 'allow_always' || option.optionId === 'allow-edits-session') {
      always = option.optionId;
      alwaysRaw = isRecord(raw) ? raw : undefined;
    }
  }
  if (!once || !reject) {
    return undefined;
  }
  const suggestions: PermissionSuggestion[] | undefined =
    always && alwaysRaw
      ? [
          {
            kind: typeof alwaysRaw.kind === 'string' ? alwaysRaw.kind : 'allow_always',
            where: SESSION_ONLY,
            raw: alwaysRaw
          }
        ]
      : undefined;
  return {
    toolName,
    label,
    input,
    suggestions,
    choices: { once, reject, ...(always ? { always } : {}) }
  };
}

/** Skip-on leftover: session-always if offered, else once. t3code full-access. */
export function autoAllow(choices: PermissionChoices): Decision {
  return choices.always ? { allow: true, always: true } : { allow: true };
}

/** The JSON-RPC result 1.0.4 accepts. Absent when this sitting cannot send it. */
export function permissionPayload(
  choices: PermissionChoices,
  decision: Decision
): { outcome: { outcome: 'selected'; optionId: string } } | undefined {
  if (!decision.allow) {
    return { outcome: { outcome: 'selected', optionId: choices.reject } };
  }
  if (decision.always) {
    if (!choices.always) {
      return undefined;
    }
    return { outcome: { outcome: 'selected', optionId: choices.always } };
  }
  return { outcome: { outcome: 'selected', optionId: choices.once } };
}
