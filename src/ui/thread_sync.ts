/** One contiguous exchange splice plus changed metadata. No event history is
 * retained: a missing content base recovers with the current full snapshot. */
export function patch(
  before: ThreadView,
  after: ThreadView,
  publication: ThreadPublication,
  base: number,
  revision: number
): ThreadPatchMessage {
  let at = 0;
  while (
    at < before.exchanges.length &&
    at < after.exchanges.length &&
    JSON.stringify(before.exchanges[at]) === JSON.stringify(after.exchanges[at])
  )
    at++;
  let oldEnd = before.exchanges.length;
  let newEnd = after.exchanges.length;
  while (
    oldEnd > at &&
    newEnd > at &&
    JSON.stringify(before.exchanges[oldEnd - 1]) === JSON.stringify(after.exchanges[newEnd - 1])
  ) {
    oldEnd--;
    newEnd--;
  }
  const changes: Partial<Omit<ThreadView, 'exchanges'>> = {};
  const unset: (keyof Omit<ThreadView, 'exchanges'>)[] = [];
  const { exchanges: _old, ...oldMetadata } = before;
  const { exchanges: _new, ...metadata } = after;
  for (const key of Object.keys(oldMetadata) as (keyof typeof oldMetadata)[])
    if (metadata[key] === undefined && oldMetadata[key] !== undefined) unset.push(key);
  for (const key of Object.keys(metadata) as (keyof typeof metadata)[])
    if (
      metadata[key] !== undefined &&
      JSON.stringify(oldMetadata[key]) !== JSON.stringify(metadata[key])
    )
      Object.assign(changes, { [key]: metadata[key] });
  return {
    type: 'threadPatch',
    ...publication,
    pid: after.pid,
    startedAt: after.startedAt,
    base,
    revision,
    changes,
    unset,
    splice: { at, remove: oldEnd - at, exchanges: after.exchanges.slice(at, newEnd) }
  };
}

export function apply(before: ThreadView, message: ThreadPatchMessage): ThreadView | undefined {
  const { at, remove, exchanges } = message.splice;
  if (
    !Number.isSafeInteger(at) ||
    !Number.isSafeInteger(remove) ||
    at < 0 ||
    remove < 0 ||
    at + remove > before.exchanges.length
  )
    return undefined;
  const next: ThreadView = {
    ...before,
    ...message.changes,
    exchanges: [
      ...before.exchanges.slice(0, at),
      ...exchanges,
      ...before.exchanges.slice(at + remove)
    ]
  };
  for (const key of message.unset) delete next[key];
  return next.pid === before.pid && next.startedAt === before.startedAt ? next : undefined;
}
