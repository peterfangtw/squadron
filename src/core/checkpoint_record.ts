import { randomUUID } from 'crypto';
import * as checkpoint from './checkpoint';
import type { Conversation } from './thread';

/** Reserve before awaiting capture: positional ck/ex lines belong to the turn
 *  preceding this slot, even if the next prompt drains during capture. */
export function enqueue(
  conversation: Conversation,
  capture: Promise<{ ck?: checkpoint.TurnCheckpoint; ex?: checkpoint.ExecutionCoverage }>
): void {
  conversation.pending(`ck:${randomUUID()}`, async (sessionId) => {
    if (!sessionId) return [];
    const { ck, ex } = await capture;
    if (ck)
      await checkpoint.appendWindow(ck.tree, {
        sid: ex?.owner ?? sessionId,
        start: ck.from.startedAt ?? ck.from.at,
        end: ck.to.at,
        paths: ck.changes.files
      });
    return [...(ck ? [{ ck }] : []), ...(ex ? [{ ex }] : [])];
  });
}
