/**
 * Grok ACP notifications → `SessionEvent[]`.
 *
 * The kinds are `core/events.ts`. Wire names (`session/update`,
 * `_x.ai/session_notification`, `_x.ai/sessions/changed`) stay in this
 * file. The brand-free machine is `applyEvent` in `core/live.ts`.
 *
 * Payloads from `docs/reference/cli_state/grok/protocol.md` (1.0.4).
 */

import type { SessionEvent, TurnOutcome } from '../events';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionRowId(row: Record<string, unknown>): string | undefined {
  if (typeof row.sessionId === 'string') {
    return row.sessionId;
  }
  if (typeof row.session_id === 'string') {
    return row.session_id;
  }
  return undefined;
}

/** Exported for `grok/tee.ts`, which reads the same notifications into our own
 *  record. One reading of this wire, not two: the live bubble and the record
 *  disagreeing about a payload is the drift this file already exists to stop. */
export function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }
  if (isRecord(content) && typeof content.text === 'string') {
    return content.text;
  }
  return undefined;
}

export function metaOf(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(value._meta) ? value._meta : undefined;
}

export function replayed(...records: readonly Record<string, unknown>[]): boolean {
  return records.some((record) => metaOf(record)?.isReplay === true);
}

/** The live reasoning-effort option from Grok's top-level `configOptions`. */
export function effortOption(value: unknown): { current: string; values: string[] } | undefined {
  if (!Array.isArray(value)) return undefined;
  const option = value.find((entry) => isRecord(entry) && entry.id === 'reasoning_effort');
  if (!isRecord(option) || typeof option.currentValue !== 'string' || !option.currentValue) {
    return undefined;
  }
  const values = Array.isArray(option.options)
    ? option.options.flatMap((entry) =>
        isRecord(entry) && typeof entry.value === 'string' && entry.value ? [entry.value] : []
      )
    : [];
  return values.includes(option.currentValue)
    ? { current: option.currentValue, values }
    : undefined;
}

/**
 * The methods a `session/update` payload rides on this CLI.
 *
 * 1.0.5 probe: 7/7 `turn_completed` rode `_x.ai/session_notification`, zero on
 * `session/update`. Disk `updates.jsonl` rewrites the same payload as
 * `_x.ai/session/update` (01a015e3, 2026-08-18).
 */
export function isUpdateMethod(method: string): boolean {
  return (
    method === 'session/update' ||
    method === '_x.ai/session/update' ||
    method === '_x.ai/session_notification'
  );
}

/**
 * ACP `session/update` params are `{ sessionId, update: { sessionUpdate } }`
 * (`updates.jsonl` 1.0.4, 2026-08-17, session 01a00dcb). A flat
 * `{ sessionUpdate }` is the fake and an older reading — accept both.
 */
export function updatePayload(
  params: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (isRecord(params.update) && typeof params.update.sessionUpdate === 'string') {
    return params.update;
  }
  if (typeof params.sessionUpdate === 'string') {
    return params;
  }
  return undefined;
}

/**
 * How a turn ended, from the word Grok states it in — `turn_completed.stop_reason`
 * or the `session/prompt` reply's `stopReason`. One reading for both closers.
 *
 * `rate_limit` is the PRD's 2026-08-19 row; no longer on disk by 2026-10-06
 * (`cli_state/grok/protocol.md` § `rate_limit` is not on disk). `interrupted`
 * (3 rows there) is the agent process exiting or restarting, not a
 * `session/cancel` — a death, which states no failure, so it is unclassified
 * like any word not named here.
 */
export function outcomeOf(stopReason: unknown): TurnOutcome | undefined {
  switch (stopReason) {
    case 'end_turn':
      return 'done';
    case 'cancelled':
      return 'interrupted';
    case 'error':
    case 'rate_limit':
      return 'error';
    default:
      return undefined;
  }
}

/** One notification, as zero or more product events. */
export function eventsFrom(method: string, params: unknown, sessionId?: string): SessionEvent[] {
  const raw = { source: 'grok' as const, nativeType: method, payload: params };
  if (isUpdateMethod(method) && isRecord(params)) {
    const update = updatePayload(params);
    // Load replay (1.0.4): `_meta.isReplay: true` on the params or the
    // inner update. Dock already has `chat_history.jsonl`.
    if (!update || replayed(params, update)) {
      return [];
    }
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = textOf(update.content);
      return text ? [{ kind: 'text', text, raw }] : [];
    }
    if (kind === 'agent_thought_chunk') {
      const text = textOf(update.content);
      return text ? [{ kind: 'thought', text, raw }] : [];
    }
    if (kind === 'tool_call') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
      const name =
        (typeof update.title === 'string' && update.title) ||
        (typeof update.name === 'string' && update.name) ||
        'a tool';
      const input = isRecord(update.rawInput) ? update.rawInput : undefined;
      return [{ kind: 'tool-start', id, name, input, raw }];
    }
    if (kind === 'tool_call_update') {
      const id = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
      const done = update.status === 'completed' || update.status === 'failed';
      if (done) {
        return [
          {
            kind: 'tool-end',
            id,
            failed: update.status === 'failed',
            raw
          }
        ];
      }
      const text = textOf(update.content) ?? textOf(update.rawOutput);
      return [{ kind: 'tool-update', id, text, raw }];
    }
    if (kind === 'model_changed') {
      const events: SessionEvent[] = [];
      if (typeof update.model_id === 'string' && update.model_id) {
        events.push({ kind: 'model', model: update.model_id, raw });
      }
      if (typeof update.reasoning_effort === 'string' && update.reasoning_effort) {
        events.push({ kind: 'effort', effort: update.reasoning_effort, raw });
      }
      return events;
    }
    if (kind === 'config_option_update') {
      const effort = effortOption(update.configOptions)?.current;
      return effort ? [{ kind: 'effort', effort, raw }] : [];
    }
    // Monitor / hook wake (1.0.4, 2026-08-17, session 01a00dcb): Grok
    // starts a turn with no `session/prompt` from us. This is the end of
    // that turn; `session/prompt`'s result is the other.
    if (kind === 'turn_completed') {
      const outcome = outcomeOf(update.stop_reason);
      // `prompt_id` echoes what the queue announced as `runningPromptId`,
      // character for character, on both kinds of turn (1.0.5 probe,
      // 2026-08-25). Carrying it is what lets a late or duplicate close be
      // matched to the turn it belongs to rather than ending whichever turn
      // happens to be running.
      const id = typeof update.prompt_id === 'string' ? update.prompt_id : undefined;
      // The turn's cached input, which the session admits only for the turn it
      // can name (`cli_state/grok/cache.md`). Summed over the turn's model calls.
      const cached = isRecord(update.usage) ? update.usage.cachedReadTokens : undefined;
      const input = isRecord(update.usage) ? update.usage.inputTokens : undefined;
      return [
        ...(typeof cached === 'number' && Number.isFinite(cached) && cached >= 0
          ? [
              {
                kind: 'cache-read' as const,
                tokens: cached,
                ...(typeof input === 'number' && Number.isFinite(input) && input > 0
                  ? { input }
                  : {}),
                raw
              }
            ]
          : []),
        {
          kind: 'turn-end',
          ...(outcome ? { outcome } : {}),
          ...(id ? { turnId: id } : {}),
          raw
        }
      ];
    }
    return [];
  }
  if (method === '_x.ai/sessions/changed' && isRecord(params)) {
    // 1.0.5 probe: 14/14 payloads `{ upserted, removed }`. Zero `sessions`.
    const rows: unknown[] = Array.isArray(params.upserted)
      ? params.upserted
      : Array.isArray(params.sessions)
        ? params.sessions
        : [];
    // The roster is every session the agent holds (1.0.4). rows[0] is some
    // other card's idle and would wipe a turn still on the wire.
    const row = sessionId
      ? rows.find((r) => isRecord(r) && sessionRowId(r) === sessionId)
      : undefined;
    if (!isRecord(row)) {
      return [];
    }
    const events: SessionEvent[] = [];
    if (row.activity === 'working' || row.activity === 'idle') {
      events.push({
        kind: 'status',
        status: row.activity === 'working' ? 'busy' : 'idle',
        raw
      });
    }
    if (typeof row.title === 'string' && row.title) {
      events.push({ kind: 'title', title: row.title, raw });
    }
    const model =
      (typeof row.model === 'string' && row.model) ||
      (typeof row.modelId === 'string' && row.modelId) ||
      undefined;
    if (model) {
      events.push({ kind: 'model', model, raw });
    }
    return events;
  }
  if (method === '_x.ai/queue/changed' && isRecord(params)) {
    // Scoped to this session, exactly as the roster branch above is. The
    // payload names its `sessionId`, and once `runningId` is read this frame
    // decides whether a card's drain may write — another session's queue
    // naming a turn we never sent would say so about the wrong card.
    if (sessionId && typeof params.sessionId === 'string' && params.sessionId !== sessionId) {
      return [];
    }
    const entries = Array.isArray(params.entries) ? params.entries : [];
    // 1.0.5 probe, 2026-08-25: the only frame that names the running turn.
    // A turn Grok starts itself is announced here and nowhere else — the
    // roster emits nothing for one and `prompt_complete` never fires — and
    // `turn_completed.prompt_id` echoes this value back exactly. Absent when
    // the frame names none; that is not the same as nothing running, because
    // a wake's queue never emits a closing frame at all.
    const running = typeof params.runningPromptId === 'string' ? params.runningPromptId : undefined;
    return [
      { kind: 'queue', depth: entries.length, ...(running ? { runningId: running } : {}), raw }
    ];
  }
  return [];
}
