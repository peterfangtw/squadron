import * as os from 'os';
import * as path from 'path';
import { SessionStatus } from '../core/model';
import * as win32Paths from '../core/platform/paths/win32';
import { windowsPath } from './local_path';

/**
 * The small renderings more than one view reaches for, without pulling the
 * whole view-model in behind them.
 */

const HOME = os.homedir();
const WINDOWS_KEYS = win32Paths.paths();

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * Text drawn as it is: escaped, and otherwise untouched.
 *
 * What `host/markdown.ts` falls back to when the host has no markdown engine,
 * so the dock loses formatting and never content. `.raw` is `white-space:
 * pre-wrap` (`ui/css/chat.ts`), so every space and newline survives.
 */
export function asTyped(text: string): string {
  return `<p class="raw">${text.replace(/[&<>]/g, (c) => ENTITIES[c] ?? c)}</p>`;
}

/** A path as a person reads it: home-relative, and `(unknown)` for no path at
 *  all — a card states where a session is or states that it cannot. */
export function shorten(cwd: string): string {
  if (!cwd) {
    return '(unknown)';
  }
  const windows = windowsPath(HOME);
  const home = windows ? WINDOWS_KEYS.key(HOME) : HOME;
  const shown = windows ? WINDOWS_KEYS.key(cwd) : cwd;
  const separator = windows ? '\\' : '/';
  return shown === home
    ? '~'
    : shown.startsWith(home + separator)
      ? '~' + cwd.slice(HOME.length)
      : cwd;
}

/** Native folder components for a heading; cwd remains the action identity. */
export function pathHeading(cwd: string): { label: string; app: string } {
  const shown = shorten(cwd);
  const cut = ordinaryWindowsPath(cwd)
    ? Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\'))
    : shown.lastIndexOf('/');
  return {
    label: cut === -1 ? shown : shown.slice(cut + 1),
    app: cut === -1 ? '' : shown.slice(0, cut)
  };
}

/**
 * A sibling checkout named for a reader, given the folder they asked about.
 *
 * The last segment, not the path to it. A picker row shows this to tell two
 * conversations on the same branch apart, and this repository's own worktrees
 * live at `.worktrees/<name>` — a relative path spends its whole width
 * on the part every one of them shares, and clips at exactly the point the name
 * begins. The segment is the checkout's own name, which is what discriminates.
 *
 * Nothing when it is the folder asked about: a row says where it is only when
 * that is somewhere else.
 */
export function checkoutLabel(asked: string, cwd: string): string | undefined {
  const separator = ordinaryWindowsPath(cwd) ? /[\\/]/ : /\//;
  return cwd === asked ? undefined : cwd.split(separator).filter(Boolean).at(-1);
}

function ordinaryWindowsPath(cwd: string): boolean {
  if (!windowsPath(cwd) || (cwd.startsWith('//') && !windowsPath(HOME))) return false;
  // Roots retain their existing slash-split display pending the root UI decision.
  return cwd.length > path.win32.parse(cwd).root.length;
}

/**
 * One session in a cascade, as much of it as the sentence needs.
 *
 * Rows rather than `Session`s because `displayName` lives in `views.ts`, which
 * imports this file: taking whole sessions would close the cycle this module
 * exists on the far side of. The caller maps the name.
 */
export type CascadeRow = {
  name: string;
  status: SessionStatus;
  waitingFor?: string;
};

/**
 * Who a cascade would end, in the space a modal has for them.
 *
 * Up to three are named, which is how this read when an end reached one hop and
 * is still the common case. Past three it counts by status instead — a descent
 * can be fourteen sessions deep, and fourteen names is a wall that gets clicked
 * through rather than read.
 *
 * That is a trade, not a rendering: naming every session an end would take used
 * to be the guarantee that made the cascade safe, and past three it is given up
 * for one a reader can actually take in. `PRD_shipped_lineage_ui.md` records
 * both halves.
 *
 * Bucketed on `status`, never on `waitingFor` — the latter is free text from
 * another program, and would give roughly one bucket per session. Busy first:
 * of the four, it is the one whose loss costs work.
 *
 * Every row lands in a bucket, and the counting is what guarantees it rather
 * than the order below: the sentence is the only account a reader gets of what
 * the button is about to end, so a status this file had not heard of must
 * misorder itself rather than disappear. `ORDER` is `satisfies
 * Record<SessionStatus, number>`, so a fifth state also fails the build here.
 */
const ORDER = { busy: 0, waiting: 1, idle: 2, unknown: 3 } satisfies Record<SessionStatus, number>;

export function cascadeList(rows: readonly CascadeRow[]): string {
  if (rows.length <= 3) {
    return rows.map((row) => `${row.name} — ${row.waitingFor ?? row.status}`).join('\n');
  }
  const counts = new Map<SessionStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const rank = (status: SessionStatus): number => ORDER[status] ?? Object.keys(ORDER).length;
  return [...counts]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
}

/**
 * What ending a session takes with it, for the confirm.
 *
 * Ending a session ends everything it started, and a subtree can hold more
 * than the tool call it looks like: a session that booted a development host has
 * a whole IDE window below it, one part-way through an install has that. So the
 * count is stated when there is one — the difference between a sweep and a
 * surprise — and the sentence is silent when there is nothing to say, which is
 * the common case and the one that should read exactly as it always has.
 *
 * "It started" rather than any name for the sweep: a person is being told what
 * happens to their machine, not how this is implemented.
 *
 * The cascade sentence is active and present-tense to match `Its card goes with
 * it.` above it: two sentences about the same act should not disagree about
 * whether it has happened yet.
 */
export function endDetail(running: number): string {
  const fate = 'Its card goes with it. The transcript is kept, the live session is not.';
  if (running < 1) {
    return fate;
  }
  // The verb agrees where the old copy did not have to: `will be stopped too`
  // read the same at any count, `end with it` does not.
  const one = running === 1;
  const subject = one ? '1 process it started' : `${running} processes it started`;
  return `${fate}\n\n${subject} ${one ? 'ends' : 'end'} with it.`;
}
