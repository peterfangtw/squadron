/** Completed Codex notifications as append-only record lines. */

import { sentTurns } from '../coordination/send';
import type { QueuedContent } from '../live';
import type { RecordLine } from '../record';
import { taskEndLines, type TaskEnd } from '../task_end';
import { linesForItem, linesForTurnEnd } from './transcript';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function time(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export class CodexTee {
  private readonly completedItems = new Set<string>();
  private readonly completedTurns = new Set<string>();
  private readonly attached = new Map<
    string,
    {
      refs: readonly (ImageRef | undefined)[];
      row: QueuedContent;
      heard: (lines: RecordLine[]) => void;
    }
  >();
  /** Sends recorded without their echo: one arriving later adds nothing. */
  private readonly settled = new Set<string>();
  /**
   * Backgrounded commands not yet completed, by item id: the started item, its
   * turn and when it started. `turn/completed` leaves such a command out of its
   * items and its `item/completed` arrives after the turn has ended
   * (`cli_state/codex/protocol.md` § *A command outlives its turn*, 0.162.1),
   * so its call is written at its turn's end and its end folds onto that.
   */
  private readonly running = new Map<
    string,
    { item: Record<string, unknown>; turn: string; at: number }
  >();
  /** Calls written at their turn's end whose completion is still to come. */
  private readonly outlived = new Set<string>();

  constructor(private readonly cwd: string) {}

  /**
   * What `turn/start` carried, keyed by its echoed client id: the row it was
   * sent from and the durable copies of its images (positional, a hole for a
   * failed copy). The matched item goes to `heard` as `sentTurns` — one turn
   * per merged message — which the echo only witnesses; `take` answers
   * nothing for it, since the send's own slot holds it.
   */
  attach(
    clientMessageId: string,
    refs: readonly (ImageRef | undefined)[],
    row: QueuedContent,
    heard: (lines: RecordLine[]) => void
  ): void {
    if (clientMessageId) this.attached.set(clientMessageId, { refs: [...refs], row, heard });
  }

  /** The send was recorded with no echo — its turn ended, or never started. */
  settle(clientMessageId: string): void {
    if (this.attached.delete(clientMessageId)) this.settled.add(clientMessageId);
  }

  take(method: string, value: unknown, at: number): RecordLine[] {
    if (!isRecord(value)) return [];
    if (method === 'item/started') {
      const item = isRecord(value.item) ? value.item : undefined;
      const id = item && typeof item.id === 'string' ? item.id : undefined;
      const turn = typeof value.turnId === 'string' ? value.turnId : undefined;
      if (item && id && turn && backgrounded(item)) {
        this.running.set(id, { item, turn, at: time(value.startedAtMs, at) });
      }
      return [];
    }
    if (method === 'item/completed') {
      const item = isRecord(value.item) ? value.item : undefined;
      const id = item && typeof item.id === 'string' ? item.id : undefined;
      if (!item || !id || this.completedItems.has(id)) return [];
      this.completedItems.add(id);
      this.running.delete(id);
      if (this.outlived.delete(id)) {
        return taskEndLines(commandEnd(item, id, time(value.completedAtMs, at)));
      }
      const clientId = typeof item.clientId === 'string' ? item.clientId : undefined;
      if (clientId && this.settled.delete(clientId)) return [];
      const sent = clientId ? this.attached.get(clientId) : undefined;
      if (clientId) this.attached.delete(clientId);
      const completed = time(value.completedAtMs, at);
      if (!sent || item.type !== 'userMessage') return linesForItem(item, completed, this.cwd);
      // A send that lost every picture and had no words is still the prompt this
      // id names — never a bare witness, which resolves to the turn after it.
      const [first, ...rest] = sentTurns(sent.row, sent.refs, completed);
      sent.heard([{ ...(first ?? { role: 'user', text: '', at: completed }), m: id }, ...rest]);
      return [];
    }
    if (method === 'turn/completed') {
      const turn = isRecord(value.turn) ? value.turn : undefined;
      const id = turn && typeof turn.id === 'string' ? turn.id : undefined;
      if (!turn || !id || this.completedTurns.has(id)) return [];
      this.completedTurns.add(id);
      const completed =
        typeof turn.completedAt === 'number' && Number.isFinite(turn.completedAt)
          ? turn.completedAt * 1000
          : at;
      return [...this.outlivedBy(id, turn.status), ...linesForTurnEnd(turn, completed)];
    }
    return [];
  }

  /**
   * A completed turn's backgrounded commands still running at its end, as
   * running calls in that turn. An interrupted turn's are left to arrive as
   * they always have: one of those may never complete (the C0 fixture's
   * `sleep 30`), and the fallback draws no call for it.
   */
  private outlivedBy(turn: string, status: unknown): RecordLine[] {
    const lines: RecordLine[] = [];
    for (const [id, started] of this.running) {
      if (started.turn !== turn) continue;
      this.running.delete(id);
      if (status !== 'completed') continue;
      this.outlived.add(id);
      lines.push(...linesForItem(started.item, started.at, this.cwd));
    }
    return lines;
  }
}

/** A command the app-server ran as a background process. Only
 *  `unifiedExecStartup` has been seen to outlive its turn. */
function backgrounded(item: Record<string, unknown>): boolean {
  return item.type === 'commandExecution' && item.source === 'unifiedExecStartup';
}

/**
 * A late command completion as a `TaskEnd`. Codex starts no turn for it —
 * nothing follows the frame, and asked later the model says it was never told —
 * so `wakes` is false and no marker is drawn.
 */
function commandEnd(item: Record<string, unknown>, id: string, at: number): TaskEnd {
  const code = item.exitCode;
  const status =
    item.status === 'completed' && code === 0
      ? 'completed'
      : item.status === 'failed' || (typeof code === 'number' && code !== 0)
        ? 'failed'
        : undefined;
  return {
    call: id,
    cause: 'command',
    ...(status ? { status } : {}),
    ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
    wakes: false,
    at
  };
}
