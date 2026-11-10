import type * as tickets from '../core/tickets';

export const DISCONNECT_ACTION = 'disconnect';

/** What a reader agrees to before a source's saved credential is deleted. */
export function disconnectConfirmation(entry: tickets.TicketConnector): ConfirmationView {
  const name = entry.offer.label;
  return {
    title: `Disconnect ${name}?`,
    detail: `Squadron deletes the saved ${name} credentials from this editor, in every window. Its tickets leave the Tickets tab until you connect it again.`,
    actions: [{ id: DISCONNECT_ACTION, label: 'Disconnect', destructive: true }]
  };
}
