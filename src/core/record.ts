/**
 * Our own record of a conversation, written from the frames the pipe carries.
 *
 * The CLI's `.jsonl` stays the fallback for what we never witnessed
 * (`TASK_inprogress_own_transcript.md`, roadmap row 54). This file is the other
 * truth: one file per conversation, keyed on `sessionId` and on
 * nothing else, so no working directory appears in a path here and none of the
 * four ways a derived transcript path has missed can reach it.
 *
 * **`.jsonl`, never `.json`** — the reason is on `TRANSCRIPTS_DIR` in
 * `core/paths.ts`, which owns the name.
 *
 * **Single writer, by construction.** Only the window holding a conversation's
 * pipe writes its record: a running conversation cannot be resumed
 * (`host/session_open.ts`), and the CLI refuses a `--session-id` that already
 * has a transcript, so a resume is sequential and after the first child is dead.
 * Appends have no second writer to interleave with; `readRecord` drops a torn
 * final line after a crash.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import type { ExecutionCoverage, Snapshot, TurnChanges, TurnCheckpoint } from './checkpoint';
import * as checkpoint from './checkpoint';
import * as recordIndex from './record_index';
import type { AnsweredAsk, Written } from './transcript';
import type { BrandId, ImageBlock, WarmTurn } from './model';
import { extForMedia } from './pastes';
import {
  HOLD_MISSES,
  MAX_TURNS,
  recentUserFrom,
  isMarker,
  warmOwned,
  type Exchange,
  type Recent,
  type ToolCall
} from './transcript';
export { ATTACHMENTS_DIR } from './paths';
import { ATTACHMENTS_DIR, TRANSCRIPTS_DIR } from './paths';

/**
 * Bump when a line's meaning changes. Unknown versions are refused whole:
 * there is no migration, and the dock must fall back rather than draw half a record.
 */
export const SCHEMA = 2;

/**
 * Keep coverage out of the header: an append-only file cannot update it when
 * the CLI comparison changes. Recompute coverage on each read.
 * Optional cwd and brand keep older records and callers without birth context
 * in the current schema: adding fields changes no line's meaning.
 */
type Header = { v: number; sessionId: string; cwd?: string; brand?: BrandId };

/**
 * What a call the record already holds returned, and — for an
 * `AskUserQuestion` — what was picked.
 *
 * A separate line rather than a field on the turn, because the two facts arrive
 * minutes apart and the file is append-only: the `tool_use` rides the
 * `assistant` frame and its `tool_result` rides a `user` frame after the call
 * has run. `readRecord` folds these back onto the call by its id, which the CLI
 * puts on both halves (2531 of 2531 results named their call —
 * `cli_state/claude/transcript.md`).
 *
 * `ask` arrives from a third place again: nothing on the wire carries
 * `toolUseResult` (Step 4), so the picks are teed beside the request they
 * answer, out of `respond()`. Two lines can therefore name one call, and the
 * fold merges them.
 */
export type Returned = {
  /** The CLI's own `tool_use.id`. */
  id: string;
  output?: string;
  failed?: true;
  ask?: AnsweredAsk;
};

/**
 * A line of the record that is not a turn.
 *
 * `m` is the **witness key of whichever brand wrote this record** — whatever
 * that CLI puts on both halves of itself for the same thing, so a record can be
 * weighed against the file. Claude's is an `assistant` frame's `message.id`;
 * Grok writes no id at all and its key is the ordinal of a *typed prompt*
 * (`prompt_index` in history, `_meta.promptIndex` in its live or disk update). Opaque here on
 * purpose: `drawable` compares sets of these strings and never reads one.
 *
 * `ck` is a turn's checkpoint — what the working tree did across it, taken off
 * two snapshots rather than off any frame (`core/checkpoint.ts`). It is a note
 * for the same reason `ret` is: the fact arrives after the turn's line is
 * already written, and the file is append-only. It needs no witness key at all,
 * because append-only *is* the ordering — the turn a checkpoint belongs to is
 * the last exchange written before it.
 *
 * It rides a turn's own line where there is a turn, and stands alone where
 * there is not — a Claude message of nothing but `thinking` (1 of 3014 here)
 * still happened, and that brand's rule counts messages rather than turns. A
 * bare witness is not free for a user-side key: it resolves to the *next* turn,
 * which is why `grok/tee.ts` stamps `m` on the prompt's own line and never
 * after it. `readRecord` gathers them into `firstSeen`; see `drawable`.
 */
type Note =
  | { wm: WarmTurn }
  | { ret: Returned[] }
  | { m: string }
  | { ck: TurnCheckpoint }
  | { ex: ExecutionCoverage };

export type RecordLine = Exchange | Note;

/**
 * Keep the whole record: drawable alone decides the Recent against the CLI's
 * evidence. firstSeen locates each witness in exchanges. A witness producing
 * no turn points at the next one, so a cut includes its successors.
 */
export type Recorded = {
  exchanges: Exchange[];
  firstSeen: ReadonlyMap<string, number>;
  /**
   * Keep raw checkpoints because attribution depends on neighbours at read time
   * (core/checkpoint.ts, attribute). Key by Exchange object so shallow slices
   * from drawable preserve the lookup.
   */
  checkpoints: ReadonlyMap<Exchange, TurnCheckpoint>;
  execution?: ReadonlyMap<Exchange, ExecutionCoverage>;
};

/**
 * Incremental positional fold. Inputs and previously returned snapshots stay
 * unchanged, and a line that changes nothing — a result for a call never seen,
 * a checkpoint with no turn to land on, a note equal to the one already there —
 * leaves `snapshot()` the object it was, so a cache keyed on it holds.
 */
export class RecordFold {
  private readonly exchanges: Exchange[] = [];
  private readonly firstSeen = new Map<string, number>();
  private readonly calls = new Map<string, { at: number; index: number }>();
  private readonly checkpoints = new Map<Exchange, TurnCheckpoint>();
  private readonly execution = new Map<Exchange, ExecutionCoverage>();
  private recorded: Recorded | undefined;
  private readonly warm = new Map<string, WarmTurn>();

  public push(line: RecordLine): void {
    const parsed = structuredClone(line) as ParsedLine;
    if (typeof parsed.m === 'string' && !this.firstSeen.has(parsed.m)) {
      // The turn this line carries has not been pushed yet, so `length` is its
      // index. A bare witness line resolves to the next turn instead, which is
      // the honest place to cut for a message that said nothing drawable.
      this.firstSeen.set(parsed.m, this.exchanges.length);
      this.recorded = undefined;
    }
    if (parsed.wm?.id) {
      this.warm.set(parsed.wm.id, parsed.wm);
      const at = this.exchanges.findIndex(
        (turn) => !isMarker(turn) && turn.role === 'warm' && turn.warmId === parsed.wm?.id
      );
      const turn = this.exchanges[at];
      if (turn && !isMarker(turn)) {
        this.exchanges[at] = { ...turn, warmEvidence: parsed.wm };
        this.recorded = undefined;
      }
      return;
    }
    if (parsed.ex) {
      const tree = (parsed.ex as { tree?: unknown }).tree;
      const ex =
        typeof tree === 'string' ? checkpoint.executionEvidenceIn(parsed.ex, tree) : undefined;
      for (let back = this.exchanges.length - 1; ex?.kind === 'coverage' && back >= 0; back--) {
        const turn = this.exchanges[back];
        if (!turn || 'mark' in turn) continue;
        if (turn.role !== 'user') this.note(this.execution, turn, ex);
        break;
      }
      return;
    }
    if (parsed.ck) {
      const ck = checkpointIn(parsed.ck);
      // Onto the turn already written, never onto one still to come: a
      // checkpoint is taken when a turn *ends*. A note with nothing before it
      // is a record that opens with one, which is not a shape anything writes
      // and is dropped rather than guessed at.
      //
      // **Walked back past markers, and never onto a user turn.** An
      // interrupted turn's `result` mints `{mark:'break'}` through the tee,
      // which runs *before* `handle` — so the marker is the last line written
      // when the note lands, and folding onto it loses the pills of exactly the
      // turn rule 1 exists to keep. A user turn is not a candidate either: a
      // checkpoint is what the session did about a prompt, not the prompt.
      for (let back = this.exchanges.length - 1; ck && back >= 0; back--) {
        const turn = this.exchanges[back];
        if (!turn || 'mark' in turn) {
          continue;
        }
        if (turn.role !== 'user') {
          this.note(this.checkpoints, turn, ck);
        }
        break;
      }
      return;
    }
    if (Array.isArray(parsed.ret)) {
      for (const returned of parsed.ret) {
        this.returned(returned);
      }
      return;
    }
    if (parsed.role === undefined && parsed.mark === undefined) {
      return;
    }
    // The witness is bookkeeping, not drawn content: Exchange has no field for it.
    const { m, ...drawn } = parsed;
    const exchange = drawn as Exchange;
    if (!isMarker(exchange) && exchange.role === 'warm' && exchange.warmId)
      exchange.warmEvidence = this.warm.get(exchange.warmId) ?? exchange.warmEvidence;
    const at = this.exchanges.length;
    this.exchanges.push(exchange);
    this.recorded = undefined;
    for (const [index, block] of (parsed.blocks ?? []).entries()) {
      const call = (block as { call?: ToolCall })?.call;
      if (call?.id) {
        this.calls.set(call.id, { at, index });
      }
    }
  }

  public snapshot(): Recorded {
    this.recorded ??= {
      exchanges: this.exchanges.slice(),
      firstSeen: new Map(this.firstSeen),
      checkpoints: new Map(this.checkpoints),
      ...(this.execution.size ? { execution: new Map(this.execution) } : {})
    };
    return this.recorded;
  }

  private note<T>(notes: Map<Exchange, T>, turn: Exchange, value: T): void {
    if (notes.has(turn) && isDeepStrictEqual(notes.get(turn), value)) return;
    notes.set(turn, value);
    this.recorded = undefined;
  }

  private returned(returned: Returned): void {
    const location = returned?.id ? this.calls.get(returned.id) : undefined;
    if (!location) return;
    const turn = this.exchanges[location.at];
    if (!turn || isMarker(turn)) return;
    const block = turn.blocks?.[location.index];
    if (!block || !('call' in block)) return;
    // An ask and its output arrive separately; each keeps the other's fields.
    const call: ToolCall = {
      ...block.call,
      ...(returned.output !== undefined ? { output: returned.output } : {}),
      ...(returned.failed ? { failed: true } : {}),
      ...(returned.ask ? { ask: returned.ask } : {})
    };
    if (isDeepStrictEqual(call, block.call)) return;
    this.recorded = undefined;
    const blocks = turn.blocks?.slice() ?? [];
    blocks[location.index] = { ...block, call };
    const updated: Exchange = { ...turn, blocks };
    this.exchanges[location.at] = updated;
    const ck = this.checkpoints.get(turn);
    if (ck) {
      this.checkpoints.delete(turn);
      this.checkpoints.set(updated, ck);
    }
    const ex = this.execution.get(turn);
    if (ex) {
      this.execution.delete(turn);
      this.execution.set(updated, ex);
    }
  }
}

export function recordFile(sessionId: string): string {
  return path.join(TRANSCRIPTS_DIR, `${sessionId}.jsonl`);
}

/**
 * Appends one line, opening the record with its header if this is the first.
 *
 * The header is written with `wx` — create-only — so the check and the write are
 * one operation rather than a stat and a hope. Answers whether the line landed;
 * like every other store here nothing throws, because a record that failed to
 * write must degrade to "draw the CLI's file", never to a broken session.
 */
export async function appendLine(
  sessionId: string,
  line: RecordLine,
  birth?: Pick<Header, 'cwd' | 'brand'>
): Promise<boolean> {
  const file = recordFile(sessionId);
  try {
    const header: Header = { v: SCHEMA, sessionId, ...birth };
    try {
      await fs.writeFile(file, JSON.stringify(header) + '\n', { flag: 'wx' });
    } catch (error) {
      // **Only `EEXIST` means "already opened".** Anything else — `EMFILE` under
      // load, a transient `ENOSPC`, the directory missing — is a header that was
      // not written, and `appendFile` below opens with `'a'`, which *creates*.
      // Swallowed, the two would not fail together: the append would succeed and
      // leave a file whose first line is an `Exchange`, `wx` would answer
      // `EEXIST` forever after, and `readRecord` would refuse the whole
      // conversation on a missing header with nothing to detect or repair it.
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // `ENOENT` is the first write of the first record after a fresh install,
        // before `ensureHome` has run. Worth one mkdir; anything else is real.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          broken.add(sessionId);
          return false;
        }
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(header) + '\n', { flag: 'wx' });
      }
    }
    await fs.appendFile(file, JSON.stringify(line) + '\n');
    return true;
  } catch {
    // The line is lost and cannot be replayed — the frame it came from is gone.
    // Everything after it would still append, leaving a record that reads as
    // whole. See `broken`.
    broken.add(sessionId);
    return false;
  }
}

/**
 * The whole record, or nothing when there is none, it cannot be read, or it was
 * written by a schema this build does not know.
 *
 * Indexed rather than tailed, which is half the point of owning it: the CLI's
 * reader takes a byte window off the end of a file whose single `tool_result`
 * lines run to hundreds of kilobytes, and then reports `truncated`. This holds
 * prose and tool summaries only and is read whole.
 *
 * `truncated` therefore says exactly one thing here — `MAX_TURNS` stopped the
 * walk — where the CLI reader's conflates that with a byte window running out.
 * Same cap, and it lives in `core/transcript.ts` because it is a fact about the
 * thread rather than about either file; see `lastTurns`.
 *
 * **Cached on `size:mtimeMs`, and the same object comes back for an unchanged
 * file** — the contract `core/claude/transcript.ts` states for its own parse,
 * and for the same caller: `renderTranscript` compares the reading it was
 * handed against the one it drew last, and skips a ~148 KB view rebuild plus a
 * markdown render per block when they are identical. Read afresh every poll,
 * that check could never hit.
 *
 * **A lost read answers what the record last held**, for `HOLD_MISSES` of them,
 * which is `core/transcript.ts`'s constant and the `.jsonl` reader's rule too. This used to answer nothing outright, on the grounds that doing so
 * "only moves the thread to the other source, which still draws it" — which is
 * true only where that source has something to draw. A session whose CLI file
 * is not there has no other source, so a single transient miss took the *whole*
 * dock off screen for one push and put it back on the next.
 */
const readingRecords = new Map<string, Promise<Recorded | undefined>>();

export async function readRecord(sessionId: string): Promise<Recorded | undefined> {
  const previous = readingRecords.get(sessionId);
  const task = (async () => {
    await previous?.catch(() => undefined);
    return readWholeRecord(sessionId);
  })();
  readingRecords.set(sessionId, task);
  try {
    return await task;
  } finally {
    if (readingRecords.get(sessionId) === task) readingRecords.delete(sessionId);
  }
}

async function readWholeRecord(sessionId: string): Promise<Recorded | undefined> {
  if (broken.has(sessionId)) {
    return undefined;
  }
  const file = recordFile(sessionId);
  let stamp: string;
  let size: number;
  let identity: string;
  try {
    const stat = await fs.stat(file);
    size = stat.size;
    identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    stamp = `${identity}:${size}:${stat.mtimeMs}`;
    misses.delete(file);
  } catch {
    return held(file);
  }
  const hit = cache.get(file);
  if (hit?.stamp === stamp) {
    return hit.recorded;
  }

  if (hit && hit.identity === identity && hit.complete && size > hit.size) {
    const handle = await fs.open(file, 'r').catch(() => undefined);
    if (!handle) return hit.recorded;
    try {
      const head = Buffer.alloc(hit.head.length);
      await handle.read(head, 0, head.length, 0);
      const guard = Buffer.alloc(hit.guard.length);
      await handle.read(guard, 0, guard.length, hit.size - guard.length);
      const stat = await handle.stat();
      if (
        `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` === identity &&
        guard.equals(hit.guard) &&
        head.equals(hit.head)
      ) {
        const chunks: Buffer[] = [];
        let at = hit.size;
        while (at < size) {
          const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - at));
          const got = await handle.read(chunk, 0, chunk.length, at);
          if (!got.bytesRead) throw new Error('record shortened');
          chunks.push(chunk.subarray(0, got.bytesRead));
          at += got.bytesRead;
        }
        const append = Buffer.concat(chunks);
        const combined = append;
        const boundary = combined.lastIndexOf(10) + 1;
        const lines = combined.subarray(0, boundary).toString('utf8').split('\n');
        const partial = Buffer.from(combined.subarray(boundary));
        // Legacy whole reads accept valid final JSON without a newline; that
        // exceptional append falls through to their full parser below.
        if (!partial.length) {
          const nextGuard = await lastBytes(handle, size);
          const after = await handle.stat();
          const current = await fs.stat(file);
          if (
            after.size < size ||
            current.ino !== stat.ino ||
            current.dev !== stat.dev ||
            (after.size === size && after.mtimeMs !== stat.mtimeMs)
          )
            throw new Error('record changed');
          for (const line of lines) {
            const parsed = parse<RecordLine>(line);
            if (parsed) hit.fold.push(parsed);
          }
          const recorded = hit.fold.snapshot();
          cache.set(file, {
            ...hit,
            stamp,
            size,
            recorded,
            guard: nextGuard,
            complete: true
          });
          return recorded;
        }
      }
    } catch {
      return hit.recorded;
    } finally {
      await handle.close();
    }
  }
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return cache.get(file)?.recorded;
  }

  const read = linesIn(raw, sessionId);
  if (!read) {
    // A refusal is an answer, not a lost read: the file was there and said
    // something this build will not draw. The reading it replaces goes with it,
    // or the next poll hands back what we have just declined.
    cache.delete(file);
    return undefined;
  }

  const fold = new RecordFold();
  for (const line of read.lines) fold.push(line);
  const recorded = fold.snapshot();
  const bytes = Buffer.from(raw);
  cache.delete(file);
  cache.set(file, {
    stamp,
    recorded,
    fold,
    size: bytes.length,
    identity,
    complete: raw.endsWith('\n'),
    head: Buffer.from(bytes.subarray(0, Math.min(64, bytes.length))),
    guard: Buffer.from(bytes.subarray(Math.max(0, bytes.length - 64)))
  });
  while (cache.size > 4) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return recorded;
}

/**
 * The record's lines as written, for a reader that folds them itself —
 * `core/thread.ts` recovering a conversation, which must fold exactly what
 * `readRecord` would.
 *
 * Nothing for a record that is not there, that a failed write has latched
 * `broken`, or whose header this build refuses: each is a conversation with no
 * record to draw. **A file that is there and cannot be read throws**, where
 * `readRecord` answers its last reading: a recovery reads once and keeps what
 * it read, so a transient miss must be retried rather than taken as empty.
 * Uncached, and caches nothing.
 */
export async function readRecordLines(
  sessionId: string,
  bounded = false,
  floor = 0
): Promise<RecordLines | undefined> {
  if (broken.has(sessionId)) return undefined;
  if (bounded) {
    try {
      const page = await recordIndex.read(recordFile(sessionId), sessionId, SCHEMA, {
        rows: MAX_TURNS,
        bytes: Infinity,
        authored: true,
        keepUserTurns: true,
        floor
      });
      return (
        page && {
          lines: page.lines,
          partial: page.from > 0,
          firstSeen: new Map(page.witnesses),
          from: page.from,
          revision: page.revision
        }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  let raw: string;
  try {
    raw = await fs.readFile(recordFile(sessionId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
  return linesIn(raw, sessionId);
}

export type RecordLines = {
  lines: RecordLine[];
  partial?: boolean;
  from?: number;
  firstSeen?: ReadonlyMap<string, number>;
  revision?: string;
};

function linesIn(raw: string, sessionId: string): RecordLines | undefined {
  const lines = raw.split('\n');
  const header = parse<Header>(lines[0]);
  if (!header || header.v !== SCHEMA || header.sessionId !== sessionId) return undefined;
  // Skip blanks and the torn line a crashed append may leave.
  const kept = lines.slice(1).flatMap((line) => {
    const parsed = parse<RecordLine>(line);
    return parsed ? [parsed] : [];
  });
  return { lines: kept };
}

/**
 * When somebody last **typed** at this session, epoch ms, as our record has it
 * — `CliAdapter.lastPromptAt` for a brand whose CLI states no prompt clock this
 * side can afford to read (Grok, Codex; see the port).
 *
 * Ours rather than the CLI's is a real narrowing: this file holds only what the
 * pipe witnessed. It is sound for the one caller there is — `workflowDates`
 * (`core/workflows/progress.ts`) reads owned sessions only, and every prompt an owned
 * session takes goes through the tee that writes this.
 *
 * **A peer message and a converged wait are not prompts, and that is Claude's
 * rule rather than a new one.** `claude/transcript.ts`'s `origin` returns
 * `authored` for both, `promptAt` picks nothing there, and its `scanBack` walks
 * on to an older typed turn — a session driven entirely by peer messages keeps
 * a stale prompt time, recorded as a known consequence in
 * `TASK_done_cross_session_verbs.md`. Counting them here instead would have
 * given one product word two rules: a `squadron-send` to a Grok card
 * following a workflow would silence its tally where the same send to a Claude
 * card does not. We read them off `from` and `role` where that CLI has to
 * unwrap its own text, which is the only difference.
 *
 * An unstamped turn is walked past for the same reason — that is what
 * `scanBack` does with an entry whose timestamp will not parse. Both tees stamp
 * every turn, so it is a corner; matching is still cheaper than a second rule.
 */
export async function recordedPromptAt(sessionId: string): Promise<number | undefined> {
  if (!sessionId) {
    return undefined;
  }
  const recorded = await readRecord(sessionId);
  for (let i = (recorded?.exchanges.length ?? 0) - 1; i >= 0; i--) {
    const turn = recorded?.exchanges[i];
    // `role !== 'user'` takes the `wait` and the `warm` with it; `from` is the peer send.
    if (!turn || isMarker(turn) || turn.role !== 'user' || turn.from !== undefined) {
      continue;
    }
    if (turn.at !== undefined) {
      return turn.at;
    }
  }
  return undefined;
}

/**
 * When this conversation last recorded an authored turn, epoch ms — a resumed
 * session's activity clock.
 *
 * A cache-warming ping and what answers it (`warmOwned`) are skipped: keeping
 * the cache warm is not activity. `includeWarm` counts them, for the cache
 * clock, which they did move.
 */
export async function recordedActivityAt(
  sessionId: string,
  options: { includeWarm?: boolean } = {}
): Promise<number | undefined> {
  if (!sessionId) return undefined;
  const turns = (await readRecord(sessionId))?.exchanges ?? [];
  const warm = warmOwned(turns);
  const traffic = new Map<string, number | undefined>();
  for (const turn of turns) {
    if (!isMarker(turn) && turn.role === 'warm' && turn.warmId)
      traffic.set(turn.warmId, turn.warmEvidence?.trafficAt);
  }
  let confirmed: number | undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn || isMarker(turn)) continue;
    if (!options.includeWarm) {
      if (!warm[i] && turn.at !== undefined) return turn.at;
      continue;
    }
    const at = warm[i]
      ? turn.warmId !== undefined
        ? traffic.get(turn.warmId)
        : (turn.warmEvidence?.trafficAt ?? (turn.role === 'assistant' ? turn.at : undefined))
      : turn.at;
    if (at !== undefined && Number.isFinite(at)) confirmed = Math.max(confirmed ?? at, at);
  }
  return confirmed;
}

/** Retain echo/recovery context without cutting into the live ten-user-turn
 * window. A tool-heavy user turn can exceed the authored-row target. */
export function capFrom(exchanges: readonly Exchange[]): number {
  let authored = 0;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const one = exchanges[i];
    if (one && !('mark' in one)) {
      authored++;
    }
    if (authored > MAX_TURNS) {
      return exchanges.some((row) => !isMarker(row) && row.role === 'user' && !row.maintenance)
        ? Math.min(i + 1, recentUserFrom(exchanges))
        : i + 1;
    }
  }
  return 0;
}

/** A line as it comes back off disk — every kind at once, since which one it is
 *  is what the fold above works out. Another program's crash is the only thing
 *  that writes a shape not on this list, and that line is skipped. */
type ParsedLine = {
  m?: string;
  wm?: WarmTurn;
  ret?: Returned[];
  ck?: unknown;
  ex?: unknown;
  role?: unknown;
  mark?: unknown;
  blocks?: unknown[];
};

/**
 * Validate checkpoints as readWindows does: attribute consumes them on every
 * poll, so a malformed note must shrink the drawing rather than break the thread.
 * Other lines trust shapes written only by this store.
 */
function checkpointIn(value: unknown): TurnCheckpoint | undefined {
  const ck = value as Partial<TurnCheckpoint> | null;
  if (!ck || typeof ck.tree !== 'string' || !snapshotIn(ck.from) || !snapshotIn(ck.to)) {
    return undefined;
  }
  const changes = ck.changes as Partial<TurnChanges> | undefined;
  if (!changes || !Array.isArray(changes.files) || !changes.sizes) {
    return undefined;
  }
  const sizes: Record<string, Written> = {};
  for (const [at, size] of Object.entries(changes.sizes)) {
    if (size && typeof size.add === 'number' && typeof size.del === 'number') {
      sizes[at] = { add: size.add, del: size.del };
    }
  }
  return {
    ...ck,
    tree: ck.tree,
    changes: { files: changes.files.filter((at): at is string => typeof at === 'string'), sizes }
  } as TurnCheckpoint;
}

function snapshotIn(value: unknown): boolean {
  const shot = value as Partial<Snapshot> | null;
  return !!shot && typeof shot.tree === 'string' && typeof shot.at === 'number';
}

/** One entry per record ever read; dies with the panel, like every cache here. */
const cache = new Map<
  string,
  {
    stamp: string;
    recorded: Recorded;
    fold: RecordFold;
    size: number;
    identity: string;
    complete: boolean;
    guard: Buffer;
    head: Buffer;
  }
>();

async function lastBytes(handle: fs.FileHandle, size: number): Promise<Buffer> {
  const guard = Buffer.alloc(Math.min(64, size));
  await handle.read(guard, 0, guard.length, size - guard.length);
  return guard;
}

/**
 * Conversations whose record lost a line to a failed write, and may not be drawn
 * again in this process.
 *
 * **`drawable` cannot see this class of hole, which is why it is latched here.**
 * That rule compares witness keys, and a key exists only for something the CLI
 * told us about. Every line this writer *authors* rather than witnesses carries
 * none — for Claude the drain's own user turn, an interrupt's `{mark:'break'}`
 * and a `{ret}`; for Grok the prompt is witnessed (it is the key) and it is the
 * assistant line that carries nothing. So one `ENOSPC` or `EMFILE` on a user-turn append would leave a
 * record silently missing what the reader typed, pass every check, and be
 * *preferred* over the CLI file that still has it. That is the exact failure
 * `drawable` exists to prevent, on the one line type it is blind to.
 *
 * In memory, so it protects the process that took the loss — which is the window
 * holding the pipe, and therefore the window whose dock is drawing the
 * conversation while it happens. A record holed this way and reopened later, in
 * another process, is not caught: the complete answer is a sequence number per
 * line, so `readRecord` sees any gap whatever wrote it, and that is a bigger
 * change than the failure's rarity has yet earned.
 */
const broken = new Set<string>();

const misses = new Map<string, number>();

/**
 * Release the cached read and drawn cut after thread.ts folds recovery into
 * memory, so the panel does not retain both copies. A later read starts afresh.
 */
export function evict(sessionId: string): void {
  const file = recordFile(sessionId);
  cache.delete(file);
  misses.delete(file);
  drawn.delete(sessionId);
}

/**
 * What a stat that would not answer says: the last reading, until the file has
 * been gone long enough to mean it.
 *
 * Read at the point of failure rather than up front, like the `.jsonl` reader's
 * — a concurrent caller may have cached a better answer while this one awaited.
 */
function held(file: string): Recorded | undefined {
  const seen = (misses.get(file) ?? 0) + 1;
  if (seen >= HOLD_MISSES) {
    misses.delete(file);
    cache.delete(file);
    return undefined;
  }
  misses.set(file, seen);
  return cache.get(file)?.recorded;
}

/**
 * How much of our record the dock may draw, or nothing when it must fall back —
 * the question Step 10 of `TASK_inprogress_own_transcript.md` exists to answer,
 * and the only thing that decides which of the two records the reader sees.
 *
 * **Everything the CLI wrote down, we saw.** `theirs` is the set of witness
 * keys in the window the fallback reader read; `ours.firstSeen` is keyed by the
 * ones our tee stamped off the pipe. If one of theirs is missing from ours,
 * turns happened that we were not there for, and drawing our record would show
 * a conversation with a hole in it. What a key *is* belongs to the brand
 * (`CliAdapter.readWitnessed`); nothing here reads one.
 *
 * It is a set test and not a count, because every denominator was ruled out: the
 * two sides mint different numbers of exchanges from the same conversation, and
 * `truncated` conflates the turn cap with the byte window — as a *count* of what
 * went unread, which is what a denominator would need. As a *bound* it is exact,
 * which is what `bounded` below asks it for. A key is sound exactly when both
 * halves of that CLI write it down for the same thing — Claude's `message.id`
 * verified on the wire 2026-08-20 and on disk (186,854 of 186,854 assistant
 * entries over the 2092 transcripts here), Grok's `prompt_index` on 316 of 317
 * sessions and across a resume by probe.
 *
 * **And only as far back as that set is evidence for.** This is the half a
 * boolean could not express, and the review of 2026-08-20 is why: the record has
 * no byte window and draws up to 400 turns, where `theirs` is a 2–8 MiB tail
 * that on a tool-heavy conversation averages **23.8** turns
 * (`core/claude/transcript.ts`, the note by `MAX_TURNS`). A yes/no answer would
 * therefore license drawing 400 turns on the evidence of 24, and any hole older
 * than the tail would be invisible — precisely the case Step 10's own "Done
 * when" names. So the drawn range is cut at the oldest turn `theirs` still
 * reaches, and `truncated` says so.
 *
 * **`bounded` is that premise, stated rather than assumed** — their reader's own
 * window or cap ended the read, so evidence stops where it stops. It is the
 * whole of when the cut above applies: a read that started at byte 0 and ran to
 * the end has no older window for a hole to hide in, and the floor is 0.
 *
 * Taking the premise for granted cost the reader their own opening prompt on
 * every conversation ever held. Claude's key names `assistant` messages and
 * nothing else, so the user turn a conversation opens with has an id on neither
 * side: no `firstSeen` entry could point at index 0, `oldest` was therefore ≥ 1
 * always, and one turn came off the front under a notice saying more was
 * unread. A user-side key like Grok's has the same off-by-one waiting in the
 * other direction, on the assistant turn before the oldest prompt — dead only
 * while that brand's reader reports `truncated: false`. Every record here that carries ids cut at 1
 * (2026-08-20), each against a CLI file small enough to read whole — which is
 * the ordinary session, not a corner of one.
 *
 * Three cases fall out of the one rule:
 *
 * - a conversation resumed with `claude --resume` outside the panel has ids in
 *   its file that never reached our pipe → fall back, wherever the hole is
 *   (a resume first appends a hole that is a tail: `missingTail`);
 * - a conversation whose `.jsonl` cannot be located hands back an empty set —
 *   "not found", "empty" and "failed" being one value at that boundary. There is
 *   then no evidence either way, and the plan's answer is to draw the record;
 * - a record written before this schema is refused by `readRecord` and never
 *   reaches here.
 *
 * The verdict is recomputed per read and never written down. It is not stable
 * over the life of a conversation and a header in an append-only file could not
 * be corrected when it changed.
 */
export function drawable(
  ours: Recorded | undefined,
  theirs: ReadonlySet<string>,
  bounded: boolean
): Recent | undefined {
  if (!ours?.exchanges.length) {
    return undefined;
  }
  // `Infinity` and not 0, because index 0 is a legitimate answer — the oldest
  // shared message being our first turn is the ordinary case, and seeding at 0
  // would read it as "nothing found" and then take the next id instead.
  let oldest = Infinity;
  for (const id of theirs) {
    const at = ours.firstSeen.get(id);
    if (at === undefined) {
      return undefined;
    }
    oldest = Math.min(oldest, at);
  }
  // Whichever cut reaches less far back wins; they answer different questions
  // and both are ceilings on the same range. An empty `theirs` leaves the cap
  // alone with it, which is the "no evidence either way" case — as does a whole
  // read, where the evidence reaches the conversation's own start.
  const floor = bounded && oldest !== Infinity ? oldest : 0;
  const from = Math.max(floor, capFrom(ours.exchanges));
  return from > 0
    ? { exchanges: ours.exchanges.slice(from), truncated: true }
    : { exchanges: ours.exchanges, truncated: false };
}

/**
 * One witness key of the brand's history, in the order that history holds it,
 * and the row of its `recent.exchanges` where the exchange the key belongs to
 * opens. Which rows belong to which key is the brand's to say (each
 * `recoverWitnessed`); along a list `from` never decreases, and it is negative
 * for a key whose rows lie before the window the read covered.
 */
export type Witness = { readonly key: string; readonly from: number };

/**
 * What our record lacks of the brand's history, as the lines to append to it —
 * **when every key it lacks comes after the last key it shares**. That is a
 * conversation continued in a terminal after this panel last held it, and its
 * turns go on the end of our record without disturbing a row of ours.
 *
 * Each missed key is a bare `{m}` ahead of its exchange's rows, so the record
 * witnesses it from then on. Nothing when there is no shared key, when a key
 * we lack sits among the ones we share (where it goes among our rows is not
 * knowable: the rows only our record holds have no key on the brand's side),
 * when nothing is missing, or when the first missed exchange opens before the
 * read's window — each is the brand's history drawn instead, as before.
 *
 * Duplicates rather than drops at the seam: a row of ours that the brand files
 * under the first missed key — Claude's prompt before a reply that was cut and
 * never saved — is appended again.
 */
export function missingTail(
  ours: Recorded,
  theirs: { readonly recent: Recent; readonly order: readonly Witness[] }
): RecordLine[] | undefined {
  const { order } = theirs;
  let shared = -1;
  for (let at = 0; at < order.length; at++) {
    if (ours.firstSeen.has(order[at]?.key ?? '')) shared = at;
  }
  const missed = order.slice(shared + 1);
  const start = missed[0]?.from;
  if (shared < 0 || start === undefined || start < 0) return undefined;
  if (order.slice(0, shared).some((one) => !ours.firstSeen.has(one.key))) return undefined;
  const rows = theirs.recent.exchanges;
  const lines: RecordLine[] = [];
  let next = 0;
  for (let at = start; at < rows.length; at++) {
    for (let one = missed[next]; one && one.from <= at; one = missed[++next]) {
      lines.push({ m: one.key });
    }
    const row = rows[at];
    if (row) lines.push(row);
  }
  for (const one of missed.slice(next)) lines.push({ m: one.key });
  return lines;
}

/**
 * `drawable`'s answer, remembered while neither side has moved.
 *
 * It has to be: the cut depends on `theirs` as well as on the record, so the
 * `Recent` is minted here rather than handed out of a cache, and a fresh one per
 * poll would defeat `renderTranscript`'s identity check — the ~148 KB view
 * rebuild plus a markdown render per block that this whole store exists not to
 * pay for. Both inputs are themselves cached objects with stable identity
 * (`readRecord` here, `parse` in `core/claude/transcript.ts`), so comparing them
 * by reference is exact and costs nothing.
 *
 * One entry per conversation ever drawn; dies with the panel, like every cache
 * here.
 */
const drawn = new Map<
  string,
  {
    from: Recorded | undefined;
    against: ReadonlySet<string>;
    /** Keyed on rather than derived from `against`. Both do come off the one
     *  cached `Parsed` today, so this compare never costs a recompute — but that
     *  is a fact about `readWitnessed`, which is the other side of the adapter
     *  seam, and a brand memoising its set while recomputing its bound would
     *  otherwise draw a stale cut with nothing to catch it. */
    bounded: boolean;
    recent: Recent | undefined;
  }
>();

/**
 * Share the empty set across adapter.ts and codex/transcript.ts: drawn keys by
 * set identity, so a fresh set would miss both that cache and renderTranscript's.
 * Empty means no evidence either way to drawable, so our record still draws whole.
 */
export const NO_WITNESS: ReadonlySet<string> = new Set();

export function drawableFor(
  sessionId: string,
  ours: Recorded | undefined,
  theirs: ReadonlySet<string>,
  bounded: boolean
): Recent | undefined {
  const hit = drawn.get(sessionId);
  if (hit && hit.from === ours && hit.against === theirs && hit.bounded === bounded) {
    return hit.recent;
  }
  const recent = drawable(ours, theirs, bounded);
  drawn.set(sessionId, { from: ours, against: theirs, bounded, recent });
  return recent;
}

/**
 * The scheme this store's images are addressed by — `r|<id>`, beside `p|` and
 * `f|` below and `t|`, which is the one scheme a single brand owns (Claude's
 * entry uuid, read by `claude/transcript.ts`'s `readImage`). `ImageRef.id` is
 * opaque to the wire and parsed only by the host, which is what lets a fifth
 * exist without a protocol change.
 */
export const REF_PREFIX = 'r|';

/**
 * The file behind a ref that has one. Two shapes do: `p|<path>` is a composer
 * paste this window wrote, and `f|<uuid>|<block>|<path>` is a file a turn
 * pointed at in its prose. The one pasted into a terminal is neither — it never
 * had a file at all, and comes back out of the transcript instead.
 *
 * The path is the tail rather than a field, so one holding a `|` survives.
 *
 * **Here rather than in a brand's module**, which is where this was written and
 * is not what either scheme is: `f|` is minted by `core/prose_images.ts`, which
 * every brand's reader calls, and by `codex/transcript.ts`; `p|` by Claude's
 * reader and Grok's alike. Both are our own address for a path already on disk,
 * so nothing here parses a CLI's spelling of anything — which is what let the
 * host reach for `core/claude/` to resolve a Grok card's ref.
 */
export function refFile(id: string): string | undefined {
  if (id.startsWith('p|')) {
    return id.slice(2);
  }
  if (!id.startsWith('f|')) {
    return undefined;
  }
  const parts = id.split('|');
  return parts.length >= 4 ? parts.slice(3).join('|') : undefined;
}

/**
 * The file behind an `r|` ref, or nothing for a ref of another scheme.
 *
 * The tail is a **file name and not a path** — `basename` is the guard, not a
 * formality: a ref reaches here off the wire, and a `..` in it would otherwise
 * read any file the extension host can. The store's own location is added back
 * here, which is what keeps it out of the record.
 *
 * The path schemes are `refFile`'s just above; this is the store's, and the two
 * are asked in turn wherever a ref becomes bytes.
 */
export function attachmentFile(id: string): string | undefined {
  if (!id.startsWith(REF_PREFIX)) {
    return undefined;
  }
  const name = path.basename(id.slice(REF_PREFIX.length));
  return name && name !== '.' && name !== '..' ? path.join(ATTACHMENTS_DIR, name) : undefined;
}

/**
 * An image the reader handed the composer, copied into this store and answered
 * as a ref.
 *
 * **Copied, not pointed at** — the split t3code makes, and for our own reason as
 * well as theirs. The bytes reach `tryDrain` as an `ImageBlock` and go on the
 * wire inside the turn; the CLI then writes them into its transcript as base64,
 * addressed by an entry uuid the pipe never carries. So this is the last moment
 * they exist as bytes we can name. A file a *turn* merely pointed at is the
 * other half of the split and is never copied: it keeps its path.
 *
 * The extension comes from the **stated** media type, never from a filename —
 * `readImage`'s own note records that a `.png` on disk is written down as
 * `image/jpeg` often enough that trusting the name mislabels it. The exchange
 * carries that type and the decoded size beside the id, as t3code's
 * `ChatImageAttachment` does — Phase 2 resolves from those rather than
 * guessing an extension and stat'ing.
 */
export async function writeAttachment(
  sessionId: string,
  image: ImageBlock
): Promise<ImageRef | undefined> {
  const ext = typeof image?.mediaType === 'string' ? extForMedia(image.mediaType) : undefined;
  if (!ext || !image.data) {
    return undefined;
  }
  // The extension rides the ref because the ref is all a reader opening a chip
  // hands back: `fetchImage` is given an id and nothing else, and the media type
  // beside it here never makes that trip. It is a file name, not a path — same
  // split `p|` already makes, and the store's own directory stays out of it.
  const name = `${sessionId}-${randomUUID()}.${ext}`;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(image.data, 'base64');
    await fs.mkdir(ATTACHMENTS_DIR, { recursive: true });
    await fs.writeFile(path.join(ATTACHMENTS_DIR, name), bytes);
  } catch {
    // A turn that loses its picture still reads; a turn that never lands does
    // not. Same degradation as every other store here.
    return undefined;
  }
  return { id: `${REF_PREFIX}${name}`, mediaType: image.mediaType, sizeBytes: bytes.length };
}

function parse<T>(line: string | undefined): T | undefined {
  if (!line) {
    return undefined;
  }
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

export type RecordPage = {
  recorded: Recorded;
  lines: RecordLine[];
  cursor: string;
  older?: string;
  newer?: string;
};

export async function readRecordPage(
  sessionId: string,
  cursor?: string,
  floor = 0
): Promise<RecordPage | undefined> {
  if (broken.has(sessionId)) return undefined;
  const page = await recordIndex.read(
    recordFile(sessionId),
    sessionId,
    SCHEMA,
    cursor === 'full' ? { floor, rows: Infinity, bytes: Infinity } : { cursor, floor }
  );
  if (!page) return undefined;
  const fold = new RecordFold();
  for (const line of page.lines) fold.push(line);
  return {
    recorded: fold.snapshot(),
    lines: page.lines,
    cursor: page.cursor,
    ...(page.older ? { older: page.older } : {}),
    ...(page.newer ? { newer: page.newer } : {})
  };
}
