import type { Conversation } from '../thread';
import type { RecordLine } from '../record';
import type { Authored } from '../transcript';
import type { Answered } from './transcript';
import type { Teed } from './tee';

/** A user turn: a prompt, a resolved wait or a ping — this CLI files each as one. */
export function isPrompt(line: RecordLine): line is Authored {
  return 'role' in line && (line.role === 'user' || line.role === 'wait' || line.role === 'warm');
}

type Overlap = { rows: number; alarm: boolean; judged: Set<string> };

/** A prompt Grok echoed with its index: a turn the recovered history may hold. */
function isWake(op: Teed): boolean {
  return op.kind === 'line' && isPrompt(op.line) && 'm' in op.line && op.line.m !== undefined;
}

export class GrokProjection {
  /**
   * The prompt indexes a resume recovered out of Grok's own history, when it
   * drew that history whole or as a tail, and how many rows of each it held. A
   * turn Grok starts itself can reach the pipe while that read is in flight
   * and be in the file already, partway; what the file holds of it is dropped
   * rather than drawn twice (`admit`).
   */
  private inHistory: ReadonlyMap<string, Answered> = new Map();
  /**
   * What the pipe said while a resume's read was in flight, from the first
   * turn Grok started itself: held until the read lands, since only then is
   * it known how much of that turn the read holds.
   */
  private overlap: Teed[] | undefined;
  /** The turn Grok started itself whose rows are being matched, if any. */
  private wake: Overlap | undefined;
  /** Rows the recovered history already holds: what arrives for them is dropped. */
  private readonly known = new Set<string>();

  constructor(
    private readonly echo: (conversation: Conversation, line: RecordLine) => void,
    private readonly log?: (line: string) => void
  ) {}

  installHistory(history: ReadonlyMap<string, Answered>): void {
    this.inHistory = history;
  }

  release(conversation: Conversation): void {
    const buffered = this.overlap;
    this.overlap = undefined;
    if (buffered) this.feed(conversation, buffered);
  }

  beginPrompt(): void {
    this.wake = undefined;
  }

  /**
   * The tee's operations, onto the current conversation — or held, while a
   * resume's read is in flight and a turn Grok started itself has begun: a
   * source boundary, since that read may hold some of that turn already.
   */
  take(conversation: Conversation, teed: readonly Teed[], recovering: boolean): void {
    if (!this.overlap && recovering && teed.some(isWake)) this.overlap = [];
    if (this.overlap) this.overlap.push(...teed);
    else this.feed(conversation, teed);
  }

  feed(conversation: Conversation, teed: readonly Teed[]): void {
    for (const op of teed) {
      if (!this.admit(op)) continue;
      if (op.kind === 'stream') {
        const took = conversation.stream(op.row, op.delta, op.at, {
          late: op.late,
          owner: op.owner
        });
        // Prose the CLI delivered and no record will hold: said, not silent.
        if (op.late && !took) this.log?.(`late text dropped: its row ${op.row} was sealed`);
      } else if (op.kind === 'close') {
        if (op.cut) conversation.cut(op.row, op.line, { late: true });
        else conversation.complete(op.row, [op.line]);
      } else if (op.kind === 'seal') {
        conversation.seal(op.row);
      } else if (op.kind === 'alarm') {
        conversation.hold(op.row, [op.line]);
      } else if (op.kind === 'echo') {
        this.echo(conversation, op.line);
      } else if (op.kind === 'line') {
        conversation.note([op.line]);
      }
    }
  }

  /**
   * Whether an operation reaches the thread, against what a resume recovered
   * out of Grok's own history.
   *
   * A turn Grok started itself can be in that history already, partway: its
   * prompt, and the rows the CLI had written when the read was made. Matched
   * by **its prompt index, then its rows in order** — the tee groups a turn's
   * notifications into rows by the rule the CLI's file uses (`grok/tee.ts`),
   * so the history's first `n` rows of that prompt are the turn's first `n`
   * rows here, and the rest came after the read. A row matched is dropped
   * whole, whatever else arrives for it; words are never compared, since two
   * turns can say the same thing. The turn's alarm, likewise, when the
   * history placed one. Everything else is admitted.
   */
  private admit(op: Teed): boolean {
    if (op.kind === 'line' && isPrompt(op.line)) {
      const m = 'm' in op.line && typeof op.line.m === 'string' ? op.line.m : undefined;
      const read = m === undefined ? undefined : this.inHistory.get(m);
      this.wake = read && { rows: read.rows, alarm: read.alarm, judged: new Set() };
      return !read;
    }
    if (op.kind === 'echo') this.wake = undefined;
    if (op.kind !== 'stream' && op.kind !== 'close' && op.kind !== 'alarm') {
      return op.kind !== 'seal' || !this.known.has(op.row);
    }
    if (this.known.has(op.row)) return false;
    const wake = this.wake;
    if (!wake || wake.judged.has(op.row)) return true;
    wake.judged.add(op.row);
    const inRead = op.kind === 'alarm' ? wake.alarm : wake.rows > 0;
    if (!inRead) return true;
    if (op.kind !== 'alarm') wake.rows -= 1;
    this.known.add(op.row);
    return false;
  }
}
