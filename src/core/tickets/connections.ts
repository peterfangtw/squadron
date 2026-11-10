import type * as tickets from '../tickets';
import * as github from './github';
import * as linear from './linear';

/**
 * Every ticket source a reader can connect, in the order the unlinked prompt
 * and the board menu's chooser offer them. Outside `core/tickets.ts` because
 * both adapters import that file.
 */
export const CONNECTORS: readonly tickets.TicketConnector[] = [linear.CONNECTOR, github.CONNECTOR];

export function connector(sourceId: string): tickets.TicketConnector | undefined {
  return CONNECTORS.find((entry) => entry.offer.sourceId === sourceId);
}

/** The source a record opens, or nothing for a missing or malformed one. */
export function openConnection(
  entry: tickets.TicketConnector,
  raw: string | undefined,
  context: tickets.OpenContext
): tickets.ConfiguredSource | undefined {
  const record = entry.decode(raw);
  return record ? entry.open(record, context) : undefined;
}
