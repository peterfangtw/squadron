import type { SessionEvent } from '../events';
import type { Conversation } from '../thread';
import type { Authored } from '../transcript';
import type { CodexTee } from './tee';

export type Receipt = {
  readonly at: number;
  readonly turnId: string | undefined;
  readonly historical: boolean;
  readonly isolated: boolean;
  readonly completed: boolean;
  readonly owner: Pick<Authored, 'maintenance' | 'warmId'> | undefined;
};

export class CodexProjection {
  private readonly openItems = new Map<string, string | undefined>();

  constructor(private readonly tee: CodexTee) {}

  end(): void {
    this.openItems.clear();
  }

  take(
    conversation: Conversation,
    method: string,
    params: Record<string, unknown>,
    events: readonly SessionEvent[],
    receipt: Receipt
  ): void {
    const { at, turnId, historical, isolated, completed, owner } = receipt;
    if (method === 'item/agentMessage/delta') {
      if ((!isolated && historical) || completed) return;
      for (const event of events) {
        if (event.kind !== 'text' || !event.id) continue;
        conversation.stream(event.id, event.text, at, {
          owner
        });
        this.openItems.set(event.id, turnId);
      }
      return;
    }
    const lines = this.tee
      .take(method, params, at)
      .map((line) =>
        owner && 'role' in line && (line.role === 'assistant' || line.role === 'cli')
          ? { ...line, ...owner }
          : line
      );
    if (
      method === 'item/completed' &&
      isRecord(params.item) &&
      typeof params.item.id === 'string' &&
      params.item.id
    ) {
      this.openItems.delete(params.item.id);
      if (lines.length) conversation.complete(params.item.id, lines);
      return;
    }
    if (method === 'turn/completed' && turnId) {
      // An interrupted turn has no completing agent item (0.160.1,
      // cli_state/codex/protocol.md). A foreign turn cannot close ours.
      for (const [row, owner] of this.openItems) {
        if (historical && owner === undefined) continue;
        if (owner !== undefined && owner !== turnId) continue;
        conversation.cut(row);
        this.openItems.delete(row);
      }
    } else if (events.some((event) => event.kind === 'status' && event.native === 'systemError')) {
      conversation.cutOpen();
      this.openItems.clear();
    }
    if (lines.length) conversation.note(lines);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
