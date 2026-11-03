/** Narrow Codex app-server notifications into the shared live-event vocabulary. */

import { windowTokens } from '../catalog';
import type { SessionEvent, TurnOutcome } from '../events';
import type { SessionStatus } from '../model';
import { permissionWord, sandboxType } from './permissions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function belongs(params: Record<string, unknown>, threadId?: string): boolean {
  return threadId === undefined || params.threadId === threadId;
}

function status(value: unknown): SessionStatus | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return undefined;
  }
  switch (value.type) {
    case 'active':
      return 'busy';
    case 'idle':
      return 'idle';
    case 'notLoaded':
    case 'systemError':
      return 'unknown';
    default:
      return undefined;
  }
}

/**
 * How a `turn/completed` turn ended, from the status word Codex states.
 *
 * `failed` is the invalid-effort capture (`cli_state/codex/protocol.md`,
 * reasoning effort). Anything else — absent, null, a word not named here —
 * states nothing. The caller still ends the turn (PRD A11).
 */
function outcome(value: unknown): TurnOutcome | undefined {
  switch (value) {
    case 'completed':
      return 'done';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'error';
    default:
      return undefined;
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function itemEvent(value: unknown, completed: boolean): SessionEvent[] {
  if (!isRecord(value) || typeof value.type !== 'string') return [];
  const id = typeof value.id === 'string' && value.id ? value.id : undefined;
  let name: string | undefined;
  switch (value.type) {
    case 'commandExecution':
      name = 'Bash';
      break;
    case 'fileChange':
      name = 'Edit';
      break;
    case 'mcpToolCall':
      name =
        typeof value.tool === 'string'
          ? `${typeof value.server === 'string' ? `${value.server}.` : ''}${value.tool}`
          : 'MCP tool';
      break;
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
      name = typeof value.tool === 'string' && value.tool ? value.tool : value.type;
      break;
    case 'webSearch':
      name = 'WebSearch';
      break;
    case 'imageView':
      name = 'ViewImage';
      break;
    case 'imageGeneration':
      name = 'ImageGeneration';
      break;
    case 'sleep':
      name = 'Sleep';
      break;
    default:
      return [];
  }
  if (completed) {
    return [
      {
        kind: 'tool-end',
        id,
        name,
        failed:
          value.status === 'failed' ||
          value.status === 'declined' ||
          value.success === false ||
          Boolean(value.error)
      }
    ];
  }
  const input = isRecord(value.arguments)
    ? value.arguments
    : value.type === 'commandExecution'
      ? {
          ...(typeof value.command === 'string' ? { command: value.command } : {}),
          ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {})
        }
      : undefined;
  return [{ kind: 'tool-start', id, name, input }];
}

/**
 * A notification may yield more than one reading (`thread/settings/updated`
 * states model, effort and approval policy together). Unknown or cross-thread
 * frames are intentionally silent.
 */
export function eventsFrom(method: string, value: unknown, threadId?: string): SessionEvent[] {
  if (!isRecord(value) || !belongs(value, threadId)) {
    return [];
  }
  switch (method) {
    case 'thread/status/changed': {
      const next = status(value.status);
      if (!next) return [];
      // The wire's own word alongside ours. Only the `unknown` arm reads it
      // (`core/live.ts:unknownFrom`), and that is the arm it exists for: two
      // very different app-server states land on that one card, and until this
      // a card found in it could not say which.
      const type = isRecord(value.status) ? value.status.type : undefined;
      return [
        { kind: 'status', status: next, native: typeof type === 'string' ? type : undefined }
      ];
    }
    case 'turn/started':
      return [{ kind: 'status', status: 'busy' }];
    case 'turn/completed': {
      const turn = isRecord(value.turn) ? value.turn : undefined;
      if (!turn) return [];
      const ended = outcome(turn.status);
      const id = typeof turn.id === 'string' && turn.id ? turn.id : undefined;
      return [
        {
          kind: 'turn-end',
          ...(ended ? { outcome: ended } : {}),
          ...(id ? { turnId: id } : {})
        }
      ];
    }
    case 'thread/name/updated':
      return typeof value.threadName === 'string' && value.threadName.trim()
        ? [{ kind: 'title', title: value.threadName.trim() }]
        : [];
    case 'thread/settings/updated': {
      const settings = isRecord(value.threadSettings) ? value.threadSettings : undefined;
      if (!settings) return [];
      const events: SessionEvent[] = [];
      if (typeof settings.model === 'string' && settings.model) {
        events.push({ kind: 'model', model: settings.model });
      }
      if (typeof settings.effort === 'string' && settings.effort) {
        events.push({ kind: 'effort', effort: settings.effort });
      }
      // The notification restates the whole of a thread's settings (probe
      // fixture `settings.json`), so both halves of the mode are here or
      // neither is — this never pairs a fresh policy with a stale sandbox.
      const mode = permissionWord(
        typeof settings.approvalPolicy === 'string' ? settings.approvalPolicy : undefined,
        sandboxType(settings.sandboxPolicy)
      );
      if (mode) {
        events.push({ kind: 'permission', mode });
      }
      return events;
    }
    case 'thread/tokenUsage/updated': {
      const usage = isRecord(value.tokenUsage) ? value.tokenUsage : undefined;
      if (!usage) return [];
      // `last`, never `total`. Both are on the wire and only one is a context
      // reading: `total` accumulates across the thread's turns, so `file.json`
      // states 135,103 beside the 18,646 actually occupying a 258,400 window,
      // and a long thread walks past the window it is a share of. No fallback
      // to it either — cumulative spend is not a coarser occupancy, it is a
      // different quantity.
      const last = isRecord(usage.last) ? usage.last : undefined;
      const contextTokens = finite(last?.totalTokens);
      // `windowTokens`, not `finite`: zero is a number, and `finite` admits it.
      // A stated zero reaching the share below divides by it — 100% on a card,
      // or `NaN` when the count is zero too. This file's rule for a window is
      // the one `catalog.ts` already writes down: positive, or not named.
      const contextWindow = windowTokens(usage.modelContextWindow);
      // Per model request, like the context reading (`cli_state/codex/cache.md`).
      const cached = finite(last?.cachedInputTokens);
      return [
        ...(contextTokens === undefined && contextWindow === undefined
          ? []
          : [{ kind: 'usage' as const, contextTokens, contextWindow }]),
        ...(cached === undefined ? [] : [{ kind: 'cache-read' as const, tokens: cached }])
      ];
    }
    case 'item/agentMessage/delta':
      return typeof value.delta === 'string' && value.delta
        ? [
            {
              kind: 'text',
              text: value.delta,
              ...(typeof value.itemId === 'string' && value.itemId ? { id: value.itemId } : {})
            }
          ]
        : [];
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/plan/delta':
      return typeof value.delta === 'string' && value.delta
        ? [{ kind: 'thought', text: value.delta }]
        : [];
    case 'item/started':
      return itemEvent(value.item, false);
    case 'item/completed':
      return itemEvent(value.item, true);
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta':
      return typeof value.delta === 'string'
        ? [
            {
              kind: 'tool-update',
              id: typeof value.itemId === 'string' ? value.itemId : undefined,
              text: value.delta
            }
          ]
        : [];
    case 'item/mcpToolCall/progress':
      return typeof value.message === 'string'
        ? [
            {
              kind: 'tool-update',
              id: typeof value.itemId === 'string' ? value.itemId : undefined,
              text: value.message
            }
          ]
        : [];
    default:
      return [];
  }
}

export function threadStatus(value: unknown): SessionStatus | undefined {
  return status(value);
}
