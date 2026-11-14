import type * as types from './types';

const HOUR = 3_600_000;

export function validSchedule(raw: unknown): raw is types.Schedule {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as types.Schedule;
  if (value.kind === 'interval')
    return Number.isInteger(value.hours) && value.hours >= 1 && value.hours <= 168;
  return (
    (value.kind === 'daily' ||
      (value.kind === 'weekly' &&
        Number.isInteger(value.weekday) &&
        value.weekday >= 1 &&
        value.weekday <= 7)) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)
  );
}

export function occurrence(definition: types.Definition, now: number): types.Occurrence {
  const { schedule, scheduleEpoch, anchorAt, handled } = definition;
  if (schedule.kind === 'interval') {
    if (anchorAt === undefined) {
      const key = `${scheduleEpoch}/interval/1`;
      return { key, handled: handled.find((item) => item.key === key) };
    }
    const duration = schedule.hours * HOUR;
    const index = Math.max(1, Math.floor((now - anchorAt) / duration));
    const key = `${scheduleEpoch}/interval/${index}`;
    let next = index + 1;
    while (handled.some((item) => item.key === `${scheduleEpoch}/interval/${next}`)) next++;
    const done = handled.find((item) => item.key === key);
    const dueAt = anchorAt + index * duration;
    return {
      key,
      dueAt,
      handled: done,
      nextDueAt: done
        ? anchorAt + next * duration
        : dueAt > now
          ? dueAt
          : anchorAt + next * duration
    };
  }
  const date = new Date(now);
  if (schedule.kind === 'weekly') date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const key = calendarKey(scheduleEpoch, schedule.kind, date);
  const dueAt = calendarDue(date, schedule);
  const done = handled.find((item) => item.key === key);
  const next = new Date(date);
  do {
    next.setDate(next.getDate() + (schedule.kind === 'daily' ? 1 : 7));
  } while (handled.some((item) => item.key === calendarKey(scheduleEpoch, schedule.kind, next)));
  return {
    key,
    dueAt,
    handled: done,
    nextDueAt: !done && dueAt > now ? dueAt : calendarDue(next, schedule)
  };
}

function calendarDue(date: Date, schedule: Exclude<types.Schedule, { kind: 'interval' }>): number {
  const [hours, minutes] = schedule.time.split(':').map(Number);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + (schedule.kind === 'weekly' ? schedule.weekday - 1 : 0),
    hours,
    minutes
  ).getTime();
}

function calendarKey(epoch: string, kind: 'daily' | 'weekly', date: Date): string {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${epoch}/${kind === 'daily' ? 'day' : 'week'}/${day}`;
}
