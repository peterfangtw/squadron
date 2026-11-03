import * as fs from 'fs/promises';
import * as path from 'path';
import { loadWindows, windowFor } from './context';
import { contextPercent } from '../catalog';
import { liveBranchFields, readCheckout, type HeadPass } from '../git';
import { readLineage, spawnedBy } from '../coordination/lineage';
import { Session, SessionStatus } from '../model';
import { SESSIONS_DIR } from '../paths';
import { readJob } from './jobs';
import { filetimeToUnixMs } from '../platform/processes';
import type { PassEvidence } from '../published';
import { scanProcesses, type ProcessTable } from '../scan';
import { locateTranscript, readStats } from './transcript';

const STATUSES: SessionStatus[] = ['busy', 'idle', 'waiting'];

/**
 * The CLI's status word as a state. `shell` is the one that does not survive
 * the trip: it is `idle` with a command still running, and the command half is
 * `hasCommand`'s to report.
 */
function readStatusWord(status: string): SessionStatus {
  if (status === 'shell') {
    return 'idle';
  }
  return (STATUSES as string[]).includes(status) ? (status as SessionStatus) : 'unknown';
}

/**
 * A field out of a session file, which is untyped JSON some other program wrote.
 * `String(...)` would put `[object Object]` on a card when a field changes shape.
 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The CLI's own words for a session that owns no terminal. Its validators list
 * `interactive` · `bg` · `daemon` · `daemon-worker`
 * (`docs/reference/cli_state/claude/sessions.md`), and everything but the first
 * owns none. Read here and nowhere above — the rest of the panel takes
 * `Session.background`.
 *
 * An absent field is a session file older than the vocabulary, which is what
 * the empty string stands for. A print-mode child is **not** one of these: it
 * writes `kind: "interactive"` and says `sdk-cli` on `entrypoint` instead.
 */
function isBackgroundKind(kind: string): boolean {
  return kind !== '' && kind !== 'interactive';
}

/**
 * Whether a pid file names the process the table holds at its pid, by the
 * table's own clock. The CLI's `procStart` follows that clock: on Darwin it
 * is UTC at second resolution, matched within 2 s, and a pid the table names
 * as `claude` is enough by itself. On win32 (2.1.296) it is the process
 * creation FILETIME as a decimal string (`"134360865491502968"`), the
 * Windows table's clock, so it must floor to the same millisecond; a name
 * alone proves nothing there, since Windows names also admit desktop helpers.
 * Any other clock proves nothing.
 */
function sameProcess(
  table: Pick<ProcessTable, 'claude' | 'starts' | 'startSource'>,
  pid: number,
  procStart: unknown
): boolean {
  const start = table.starts.get(pid);
  switch (table.startSource) {
    case 'win32-filetime-ms-v1':
      return !!start && typeof procStart === 'string' && filetimeToUnixMs(procStart) === start;
    case 'ps-lstart-v1':
      return (
        table.claude.has(pid) ||
        (!!start &&
          typeof procStart === 'string' &&
          Math.abs(start - Date.parse(`${procStart} UTC`)) < 2000)
      );
    default:
      return false;
  }
}

/** The start a pid file records, on the table's clock; undefined if unreadable. */
function startOf(table: Pick<ProcessTable, 'startSource'>, procStart: unknown): number | undefined {
  if (typeof procStart !== 'string') return undefined;
  switch (table.startSource) {
    case 'win32-filetime-ms-v1':
      return filetimeToUnixMs(procStart);
    case 'ps-lstart-v1': {
      const ms = Date.parse(`${procStart} UTC`);
      return Number.isNaN(ms) ? undefined : ms;
    }
    default:
      return undefined;
  }
}

/**
 * The CLI writes one file per live session keyed by pid, which is the only
 * source that knows a session's status and name. Only a piped session's file
 * and a background one's are read past the first check — a session somebody
 * typed `claude` for is not ours to know. It is cross-checked against the
 * process table because those files outlive crashed sessions, and enriched
 * from the transcript for model and context, which they do not carry.
 */
export async function discover(
  // One HEAD read per git directory for the whole sweep — the sessions of one
  // worktree are the overlap, and there are as many of them as there are cards.
  pass: HeadPass = new Map(),
  given?: ProcessTable,
  // A caller that judges this board (waits) learns here what was not read.
  evidence?: PassEvidence
): Promise<Session[]> {
  let names: string[];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch (error) {
    // Missing is a machine with no sessions; anything else is unread.
    if (evidence && (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT')
      evidence.listed = false;
    return [];
  }

  // Above the loop rather than in it: `windowFor` is synchronous, so the sizes
  // an earlier window learnt have to be in the map before the first card asks.
  // Memoised after the first pass, and never a reason for a pass to fail.
  await loadWindows();

  const table = given ?? (await scanProcesses());
  const { starts, shellParents } = table;
  // Read here rather than passed in: a parameter would reach panel.ts, the tests
  // and the `node -e` snippets for a map this function can fetch itself.
  const lineage = await readLineage();

  const sessions = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (name) => {
        // One read and one decode, which say both what the board shows and,
        // to a caller judging it, what could not be read: a file that cannot
        // be read, parsed or decoded is unread, never a session gone. A valid
        // file this drops (stale, typed, finished) was read.
        const named = Number(/^([1-9]\d*)\.json$/.exec(name)?.[1]);
        const unread = (): undefined => {
          if (Number.isSafeInteger(named)) evidence?.unread.add(named);
          return undefined;
        };
        let parsed: unknown;
        try {
          parsed = JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, name), 'utf8'));
        } catch (error) {
          // Removed between the listing and its read: that session is gone.
          return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? undefined : unread();
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unread();
        const raw = parsed as Record<string, unknown>;
        const pid = Number(raw.pid);
        if (
          !Number.isSafeInteger(pid) ||
          pid <= 0 ||
          (Number.isSafeInteger(named) && pid !== named) ||
          (raw.procStart !== undefined && typeof raw.procStart !== 'string')
        )
          return unread();
        // A pid file can outlive its process, and a recycled pid can belong to
        // something else entirely, so require the process to still be there.
        // Background sessions run under the daemon rather than as a `claude`
        // process, so they are matched on start time instead of on name.
        if (!sameProcess(table, pid, raw.procStart)) {
          // A running pid whose file carries no start this clock can read is
          // unread, not stale: only a readable start can prove another process.
          return table.starts.has(pid) && startOf(table, raw.procStart) === undefined
            ? unread()
            : undefined;
        }
        // Ours or background, and nothing else: `sdk-cli` is the one word on
        // disk for a session driven over a pipe, and a session somebody typed
        // `claude` for is dropped here, before any read below is paid for it.
        //
        // **This field is load bearing for our own cards too.** An owned card
        // takes its lineage box, effort, `hasCommand` and git fields off the
        // twin read here (`ui/views.ts` `withTwin`), so a CLI that stops
        // writing `sdk-cli` does not merely hide other windows' sessions — it
        // strips every owned card (`reference/cli_state/claude/sessions.md`).
        const background = isBackgroundKind(str(raw.kind));
        if (str(raw.entrypoint) !== 'sdk-cli' && !background) {
          return undefined;
        }

        const status = str(raw.status);
        // `shell` is idle-with-a-backgrounded-command, so it is read as the
        // state it stands for and the half it drops is carried by `hasCommand`,
        // which the process table can answer in every state.
        const sessionId = str(raw.sessionId);
        // Where the session lives, and its transcript — neither of which the pid
        // file's `cwd` still answers for once the session has stepped elsewhere:
        // the CLI rewrites that field on every `cd`, the transcript stays put.
        const { file: transcript, home: cwd } = await locateTranscript(str(raw.cwd), sessionId);
        const session: Session = {
          pid,
          sessionId,
          cwd,
          name: str(raw.name),
          nameSource: str(raw.nameSource) || undefined,
          status: readStatusWord(status),
          hasCommand: shellParents.has(pid) || status === 'shell',
          waitingFor: str(raw.waitingFor) || undefined,
          // `ps`, and not the `startedAt` in the file: this CLI stamps that
          // when it finishes booting, 6781 ms after its own fork on a machine
          // running ten sessions (2026-09-16, `sessions.md`). Every join on
          // this field is against a stamp taken at the spawn, so that one slow
          // boot put the session outside `sameSessionStart` for the rest of its
          // life — its published record dropped at the fold, and no shim able
          // to name the window holding its pipe. Grok and Codex were already on
          // this clock.
          //
          // Not even a fallback, which could only put the boot clock back:
          // nothing reaches this line without a `ps` row, since the guard above
          // admits a pid from the scan's own map or by reconciling `procStart`
          // against `lstart`.
          startedAt: starts.get(pid) ?? 0,
          background: background || undefined,
          updatedAt: Number(raw.updatedAt) || 0,
          transcript
        };

        // Parentage, on the pid keys the spawn could have used; the rule and
        // its bounds are `core/coordination/lineage.ts`'s.
        Object.assign(session, spawnedBy(lineage, { pid, startedAt: session.startedAt }));

        const jobId = str(raw.jobId);
        if (jobId) {
          const job = await readJob(jobId);
          // A bg session's bg-spare host is a pooled worker that outlives the
          // work, so liveness cannot retire it — the job's terminal state does.
          // Drop it as if the process were gone, and say so to a caller
          // judging this board: the worker runs on, but this session ended.
          if (job?.state === 'done' || job?.state === 'failed') {
            evidence?.retired.add(pid);
            return undefined;
          }
          session.needs = job?.needs;
        }

        // Where that cwd sits in git. Two files, no subprocess — and nothing at
        // all when the directory is in no repository, or in one that has since
        // been removed. Below the return above on purpose: a session already
        // being dropped should not be paying for two reads a poll.
        // Assigned wholesale because `Checkout`'s fields are `Session`'s, which
        // also keeps the keys git.ts left absent absent.
        Object.assign(session, await readCheckout(cwd, pass));

        // Whether the name above is one somebody stated, read before anything
        // else writes over it. `--name` and `/rename` both rewrite this file,
        // and the marker they leave has changed spelling: 2.1.220–2.1.241
        // **deleted** `nameSource`, 2.1.258 writes `"nameSource":"user"` for
        // both doors (sessions.md, "`nameSource` observed values"). So the test
        // is "not `derived`" and covers both — read as the absence, as it was,
        // it called every renamed session on 2.1.258 unstated and reopened the
        // door the 2026-08-25 fix shut. The cost of the wider test is that a
        // future source word this repo has never seen counts as a statement,
        // which is the safe direction: `views.ts`'s `named` has guarded on
        // `derived` alone throughout, so the two now agree.
        //
        // **A guess may not overwrite a stated name.** The file is rewritten the
        // instant a rename runs, where the transcript keeps restamping the
        // pre-rename `ai-title` for the life of the session — so a rename used
        // to land, be read, and then be undone by the next poll. A name stated
        // somewhere *else* still gets through, which is the `custom-title` case
        // below.
        const stated = Boolean(session.name) && session.nameSource !== 'derived';

        // The transcript answers what the session file does not carry. Cheap:
        // a tail of a file the CLI wrote seconds ago is a page-cache hit.
        const stats = await readStats(session.transcript);
        session.permissionMode = stats?.permissionMode;
        session.model = stats?.model;
        session.effort = stats?.effort;
        // A session wanders out of the directory it was started in and the
        // session file's `cwd` never follows. Only the transcript records a
        // move made by anything other than a shell `cd` — a worktree tool
        // included, which is how a session spawned into this panel moves.
        // Branch follows the live reading; `worktree`/`repoRoot` stay on
        // `cwd` — see `Session.liveWorktree`.
        const liveDir = stats?.cwd;
        if (liveDir && liveDir !== cwd) {
          const live = await readCheckout(liveDir, pass);
          const fields = live && liveBranchFields(live);
          if (fields) {
            Object.assign(session, fields);
          }
        }
        session.contextTokens = stats?.tokens;
        // The share, when the window this model answers in is known. A model
        // nobody has a size for leaves the count standing on its own — the one
        // thing here that must not become a guess.
        const size = windowFor(stats?.modelId);
        if (size !== undefined && stats?.tokens !== undefined) {
          session.contextPct = contextPercent(stats.tokens, size);
          session.contextSize = size;
        }
        // `titleSource` carries which entry answered, because the two are not
        // the same claim. A `custom-title` is a name somebody gave, so it
        // outranks the file's own — that is the one door a rename this window
        // cannot see comes through — and it is published the way the session
        // file publishes a given name, with no `nameSource` at all, which is
        // what stops `displayName` folding it away. The titler's guess is not a
        // statement and stops at one.
        if (stats?.title && (!stated || stats.titleSource === 'custom-title')) {
          session.name = stats.title;
          session.nameSource = stats.titleSource === 'custom-title' ? undefined : 'ai-title';
        }

        return session;
      })
  );

  // Oldest first, and by pid when two started in the same second, which `ps`
  // `lstart` makes routine rather than a curiosity — it states no finer. Status
  // deliberately does not order this: a card that moves while being read or
  // clicked costs more than surfacing a waiting session ever gained.
  return sessions
    .filter((s): s is Session => s !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}
