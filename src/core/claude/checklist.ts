import * as fs from 'fs/promises';
import * as path from 'path';
import { ackFile } from '../acks';
import { Checklist, speaks } from '../checklist';
import { readJson, writtenAt } from '../files';
import type { Session } from '../model';
import { TASKS_DIR } from '../paths';
import { readLastPromptAt } from './transcript';

/**
 * The step list a session keeps for itself, and what it says about whether the
 * work is finished.
 *
 * This is the CLI's own checklist — the one it prints while it works — written
 * to `~/.claude/tasks/<sessionId>/`, one `N.json` per step. It is the only
 * structured, agent-authored statement of what a session was asked to do and
 * how much of it is left, which is what makes a card able to say `done` or
 * `stalled` instead of `idle` for both.
 *
 * Observed 2026-07-29, CLI 2.1.220, by driving a session and watching the
 * directory: a step is `{ id, subject, description, activeForm, status, blocks,
 * blockedBy }`; `status` moves `pending` -> `in_progress` -> `completed` in
 * place on the same file, so it reads true at any moment rather than only at the
 * end; deleting a step removes its file and writes `.highwatermark`, which holds
 * the highest id issued so ids are never reused.
 *
 * Undocumented, and it has moved before — `docs/reference/cli_state/claude/sessions.md`
 * described this directory as holding nothing but `.lock` and `.highwatermark`,
 * which was true when it was written. So every read here is optional and every
 * failure is silent: a card degrades to the `idle` it shows today rather than
 * to a wrong word.
 */

/** How a step's own file spells the states. Anything else counts as unfinished:
 *  a word we have not seen is not a promise that the work is done. */
const COMPLETE = 'completed';

export function checklistDir(sessionId: string): string {
  return path.join(TASKS_DIR, sessionId);
}

/**
 * The session's step list, or nothing when there is none to read — no
 * directory, an empty one (the CLI makes it before the agent writes a step),
 * or nothing in it that parses.
 *
 * Only `N.json` counts. `.lock` and `.highwatermark` are the CLI's bookkeeping
 * and neither is a step; matching on the shape of the name rather than on "not
 * one of those two" is what keeps a file a later CLI adds from being counted as
 * work nobody planned.
 */
export async function readChecklist(sessionId: string): Promise<Checklist | undefined> {
  const dir = checklistDir(sessionId);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const steps = names.filter((name) => /^\d+\.json$/.test(name));
  if (!steps.length) {
    return undefined;
  }
  // Each step is read whole and returned, rather than folded into a running
  // total here: a `let` updated across an `await` is read before the await
  // suspends and written after every sibling has read it, so the fold would
  // keep whichever `stat` resolved last instead of the newest — a list would
  // date itself at random and `readCompletion` would drop it half the time.
  const read = (
    await Promise.all(
      steps.map(async (name) => {
        const file = path.join(dir, name);
        const step = await readJson<{ status?: unknown }>(file);
        if (step === undefined) {
          return undefined; // half-written, or a shape this does not know — not a step
        }
        return { complete: step?.status === COMPLETE, at: (await writtenAt(file)) ?? 0 };
      })
    )
  ).filter((step) => step !== undefined);
  return read.length
    ? {
        total: read.length,
        completed: read.filter((step) => step.complete).length,
        newestAt: Math.max(...read.map((step) => step.at))
      }
    : undefined;
}

/** What a card says about a session's progress. `total` is never zero: a list
 *  with no steps in it is no list. */
export type Completion = { total: number; completed: number };

/**
 * The session's progress, or nothing when we cannot honestly say.
 *
 * The staleness test is the whole of why this is not just `readChecklist`. A
 * finished list that predates the last thing somebody said to the session is
 * about work it has already moved past, and reading `done` off it would tell
 * the person watching the board to stop looking at a session that may well be
 * waiting on them. When in doubt, say nothing — the card is exactly as good as
 * it is today.
 *
 * The transcript is read only once a list exists, which is what keeps this off
 * the sessions it can never say anything about. A session with a list and no
 * readable prompt is one turn in, and its list is the newest thing there is.
 *
 * The second test is the same shape against a different date. A finished list
 * the reader has already opened has been delivered, and `done` is a message
 * rather than a state: saying it again on Friday about work that ended on
 * Tuesday is the card taking up a colour for nobody. So a list that is finished
 * and no newer than the last time somebody opened the session says nothing, and
 * the card reads plain `idle` (`core/acks.ts`).
 *
 * **Only a finished list retires.** `stalled` is the reading this feature was
 * built for — steps left and nothing running is work sitting still that no
 * other state on the board would show — and a card that hid it on the first
 * click would hide the one thing worth finding. A list that finishes *after*
 * the mark is new work ending, and says `done` again on its own.
 */
export async function readCompletion(
  sessionId: string,
  transcript: string
): Promise<Completion | undefined> {
  const list = await readChecklist(sessionId);
  if (!list) {
    return undefined;
  }
  return speaks(list, await listDates(sessionId, transcript, list))
    ? { total: list.total, completed: list.completed }
    : undefined;
}

/**
 * The same read for one card, refused for every brand but this one.
 *
 * `~/.claude/tasks/<id>/` is Claude's directory and no other CLI writes one, so
 * a Grok or Codex id looked up there is a `readdir` that has missed on every
 * poll since that brand boarded — and the day two CLIs issue the same id it
 * stops missing and starts answering about somebody else's work.
 *
 * The refusal is here rather than at the caller because the checklist is not a
 * port: `host/panel.ts`'s `relocate` crosses the adapter seam for the
 * transcript and holds no brand `if` of its own, and a Claude-only side path
 * states its own brand in its own module
 * (`TASK_done_adapter_bypasses.md`, "Claude-only side paths stay
 * Claude-only"). A session that states no brand is Claude — every record
 * written before that field existed, and every card `discover` here finds.
 */
export async function cardCompletion(
  session: Pick<Session, 'brand' | 'sessionId'>,
  transcript: string
): Promise<Completion | undefined> {
  if ((session.brand ?? 'claude') !== 'claude' || !session.sessionId) {
    return undefined;
  }
  return readCompletion(session.sessionId, transcript);
}

/** The two marks a list is dated against. Read lazily: a list still short of
 *  done never retires, so its ack is never worth an open. */
export async function listDates(
  sessionId: string,
  transcript: string,
  list: Checklist
): Promise<{ promptAt?: number; ackAt?: number }> {
  return {
    promptAt: transcript ? await readLastPromptAt(transcript) : undefined,
    ackAt: list.completed >= list.total ? await writtenAt(ackFile(sessionId)) : undefined
  };
}
