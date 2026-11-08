import { randomUUID } from 'crypto';
import type { TurnCheckpoints } from './checkpoint';
import * as checkpointRecord from './checkpoint_record';
import type { Conversation } from './thread';

/** What a brand's execution observer reports when its turn's capture closes. */
export type Observation = NonNullable<Parameters<TurnCheckpoints['closeExecution']>[1]>;

/** The part of `TurnCheckpoints` a turn's capture drives. */
export type CapturePort = Pick<
  TurnCheckpoints,
  'openUnknown' | 'uncertainExecution' | 'closeExecution' | 'discard'
>;

/** The facts of one live state that move a capture. */
export interface CaptureEdge {
  readonly running: boolean;
  readonly warm: boolean;
  readonly inFlight: boolean;
  readonly cwd: string;
}

/**
 * One owned session's turn capture: its execution observer, the uncertain
 * wake a native turn opens, and the end checkpoint with its thread slot.
 *
 * The drain's own baseline latch (`capturing` in each brand) stays with the
 * drain, so every call that depends on it is told `baselining`. The observer
 * is the brand's own type; frames reach it through `observer`.
 *
 * Methods are called on `checkpoints` itself, never on bound copies: a test
 * counts calls by patching them on the instance.
 */
export class TurnCapture<O> {
  private current?: O;
  private wake?: () => void;
  private wasRunning = false;

  constructor(
    private readonly checkpoints: CapturePort,
    private readonly runtime: string,
    private readonly conversation: () => Conversation,
    private readonly finish: (observer: O) => Observation
  ) {}

  /** The open turn's observer, for frames and for a drain's identity check. */
  get observer(): O | undefined {
    return this.current;
  }

  /** Whether the last edge `follow` saw was running. */
  get running(): boolean {
    return this.wasRunning;
  }

  /** A drain's observer, installed once its baseline is taken. */
  install(observer: O | undefined): void {
    this.current = observer;
  }

  /** A drain that will not send: its baseline and its observer both go. */
  discard(): void {
    this.checkpoints.discard();
    this.current = undefined;
  }

  /**
   * A turn this session did not release has started. Two independent rules:
   *
   * - **Uncertain wake.** While a drain is baselining, or an observer waits for
   *   a prompt not yet in flight, a native turn may write under that baseline.
   *   That span is recorded as uncertain, once, until `releaseWake`.
   * - **Unknown turn.** With no observer and no drain, the turn gets an
   *   execution of its own, with no baseline, and a new observer.
   *
   * Maintenance turns never reach here; the brand filters them.
   */
  opened(
    at: { cwd: string; owner: string; id: string; inFlight: boolean; baselining: boolean },
    create: () => O
  ): void {
    const context = { owner: at.owner, runtime: this.runtime, turn: at.id };
    if ((at.baselining || (this.current && !at.inFlight)) && !this.wake)
      this.wake = this.checkpoints.uncertainExecution(at.cwd, context);
    if (!this.current && !at.baselining) {
      void this.checkpoints.openUnknown(at.cwd, context);
      this.current = create();
    }
  }

  /** The native turn an uncertain wake belongs to has ended. */
  releaseWake(): void {
    this.wake?.();
    this.wake = undefined;
  }

  /**
   * The other end of `TurnCheckpoints`' rule 1: what this turn did, filed on
   * the turn it belongs to.
   *
   * **Not while a drain is baselining.** The baseline then belongs to a turn
   * not released yet, and `close` consumes whatever it finds, so an edge here
   * would spend the next turn's baseline on a span that wrote nothing. A ping
   * is maintenance and is never captured.
   *
   * The capture is started now, so it consumes the baseline before a `close`
   * or the child's exit can clear it in the same tick, and its `{ck}` slot is
   * reserved before anything awaits. The diff holds the disk behind it for
   * 43ms warm, capped at two `SPAWN_MS` spawns. Awaiting first would let a
   * drain releasing inside the diff put the next turn's prompt ahead of the
   * note, which folds onto whatever was written last. The window goes to the
   * per-tree store first: it is the evidence a neighbour subtracts our paths
   * from.
   *
   * `cwd` is passed even where a brand's cwd never moves, because
   * `TurnCheckpoints.close` re-reads its tree root against the baseline's.
   *
   * A repeat consumes nothing: with no baseline and no execution open,
   * `closeExecution` resolves empty.
   */
  ended(cwd: string, at: { warm: boolean; baselining: boolean }): void {
    if (at.warm || at.baselining) return;
    const observer = this.current;
    this.current = undefined;
    const taken = this.checkpoints.closeExecution(
      cwd,
      observer === undefined ? undefined : this.finish(observer)
    );
    checkpointRecord.enqueue(this.conversation(), taken);
  }

  /**
   * The edges of a brand whose turns show only as `running`. `wasRunning` is
   * what makes a turn's second closer a no-op. A warm turn neither opens nor
   * closes a capture, though its edge is still remembered. `opener` is absent
   * while the session has no id to own a turn by.
   *
   * A child that died mid-turn still wrote what it wrote, so an exited state
   * ends its turn like any other; an interrupt reaches here as a turn end.
   */
  follow(
    edge: CaptureEdge,
    opener: { owner: string; create: () => O } | undefined,
    baselining: boolean
  ): void {
    if (!edge.warm && this.wasRunning && !edge.running) {
      this.releaseWake();
      this.ended(edge.cwd, { warm: false, baselining });
    }
    if (!edge.warm && !this.wasRunning && edge.running && opener)
      this.opened(
        {
          cwd: edge.cwd,
          owner: opener.owner,
          id: randomUUID(),
          inFlight: edge.inFlight,
          baselining
        },
        opener.create
      );
    this.wasRunning = edge.running;
  }
}
