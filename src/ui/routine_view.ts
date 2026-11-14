import * as schedule from '../core/routines/schedule';
import type * as types from '../core/routines/types';

export type RunPresence = 'busy' | 'idle' | { kind: 'foreign'; label?: string };

export function routineRows(
  snapshot: types.Snapshot,
  now: number,
  local: (attempt: types.Attempt) => RunPresence | undefined
): RoutineRowView[] {
  const { repository } = snapshot;
  return Object.values(repository.routines)
    .filter((definition) => definition.deletedAt === undefined)
    .map((definition) => {
      const occurrence = schedule.occurrence(definition, now);
      const active = definition.activeRunId
        ? repository.attempts[definition.activeRunId]
        : undefined;
      const last = Object.values(repository.attempts)
        .filter((attempt) => attempt.routineId === definition.id && attempt.runId !== active?.runId)
        .sort((a, b) => b.requestedAt - a.requestedAt)[0];
      const presence = active ? local(active) : undefined;
      const localState = typeof presence === 'string' ? presence : undefined;
      const foreign = typeof presence === 'object' ? presence : undefined;
      const status: RoutineRowView['status'] = active
        ? localState
          ? localState === 'busy'
            ? 'Running'
            : 'Awaiting completion'
          : foreign
            ? 'In another window'
            : !active.reason &&
                (active.phase === 'reserved' ||
                  active.phase === 'spawning' ||
                  active.phase === 'child' ||
                  active.phase === 'bound')
              ? 'Starting'
              : 'Unresolved'
        : !definition.enabled
          ? 'Paused'
          : occurrence.handled
            ? occurrence.handled.outcome === 'completed'
              ? 'Completed'
              : 'Skipped'
            : last?.phase === 'stopped' && last.occurrenceKey === occurrence.key
              ? 'Needs attention'
              : occurrence.dueAt !== undefined && occurrence.dueAt <= now
                ? 'Due'
                : 'Upcoming';
      return {
        id: definition.id,
        definitionRevision: definition.definitionRevision,
        name: definition.name,
        enabled: definition.enabled,
        schedule: definition.schedule,
        status,
        occurrenceKey: occurrence.key,
        nextDueAt: occurrence.nextDueAt,
        due:
          definition.enabled &&
          !active &&
          !occurrence.handled &&
          occurrence.dueAt !== undefined &&
          occurrence.dueAt <= now,
        runId: active?.runId,
        sessionAction: active
          ? localState
            ? 'openLocal'
            : foreign
              ? 'switchWindow'
              : 'unavailable'
          : undefined,
        location: active?.cwd,
        windowLabel: foreign?.label,
        reason:
          active?.reason ??
          (status === 'Unresolved'
            ? active?.observation?.coverage === 'limited'
              ? 'Descendant coverage is limited; cleanup cannot yet be confirmed. Recheck the original run.'
              : 'Startup or cleanup evidence is incomplete. Recheck the original run.'
            : !active && last?.phase === 'stopped'
              ? last.reason
              : undefined),
        lastRun: last
          ? { at: last.requestedAt, done: last.phase === 'done', note: last.note }
          : undefined
      };
    });
}
