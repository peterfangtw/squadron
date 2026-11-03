import { dot } from 'node:test/reporters';
import scopes from './skip-scopes.cjs';

/**
 * Node's `dot` on the terminal, then the run's skips and todos by the scope
 * their reason opens with:
 *
 *   ℹ skipped by scope: posix 1, win32 4 (+1 suite)
 *
 * Node's own `skipped N` leaves a skipped `describe` out altogether (Node
 * 23.11: its children are never reported); this counts it. One reporter
 * wrapping `dot` rather than a second on stdout, whose lines landed inside
 * dot's failure list. A reason with no scope counts as `unscoped`: the lint
 * rule stops the literals, this catches what a helper built at run time.
 */
export default async function* report(events) {
  const tally = { skip: new Map(), todo: new Map() };
  yield* dot(counted(events, tally));
  if (tally.skip.size > 0) yield `ℹ skipped by scope: ${line(tally.skip)}\n`;
  if (tally.todo.size > 0) yield `ℹ todo by scope: ${line(tally.todo)}\n`;
}

async function* counted(events, tally) {
  for await (const event of events) {
    const { type, data } = event;
    if (type === 'test:pass' || type === 'test:fail') {
      for (const kind of ['skip', 'todo']) {
        if (data[kind] === undefined || data[kind] === false) continue;
        const scope = scopes.scopeOf(data[kind]) ?? 'unscoped';
        const row = tally[kind].get(scope) ?? { tests: 0, suites: 0 };
        if (data.details?.type === 'suite') row.suites++;
        else row.tests++;
        tally[kind].set(scope, row);
      }
    }
    yield event;
  }
}

function line(rows) {
  return [...rows]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, { tests, suites }]) => {
      const plural = suites === 1 ? 'suite' : 'suites';
      if (tests === 0) return `${scope} ${suites} ${plural}`;
      return suites === 0 ? `${scope} ${tests}` : `${scope} ${tests} (+${suites} ${plural})`;
    })
    .join(', ');
}
