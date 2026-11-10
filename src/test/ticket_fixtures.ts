import type * as backlog from '../core/backlog';
import type * as tickets from '../core/tickets';

export function ticketPriority(value = 2): TicketPriority {
  const scale: TicketTone[] = ['none', 'urgent', 'high', 'medium', 'low'];
  const labels = ['None', 'Urgent', 'High', 'Medium', 'Low'];
  return {
    value: String(value),
    label: labels[value] ?? 'None',
    order: value || 5,
    tone: scale[value] ?? 'none'
  };
}

export function ticketState(label: string): TicketState {
  return { value: 'name:' + label, label, order: 0 };
}

export function ticketSourceView(over: Partial<TicketSourceStatus> = {}): TicketSourceStatus {
  return {
    linked: true,
    sourceId: 'linear',
    token: { generation: 1, selectionSeq: 0, scopeId: 'team-a' },
    scopeId: 'team-a',
    scopes: [
      { id: 'team-a', key: 'ENG', label: 'Engineering' },
      { id: 'team-b', key: 'OPS', label: 'Operations' }
    ],
    presentation: {
      label: 'Linear',
      mark: 'linear',
      reconfigureLabel: 'Paste a different Linear API key'
    },
    offers: [
      { sourceId: 'linear', label: 'Linear', mark: 'linear', detail: 'Personal API key' },
      {
        sourceId: 'github',
        label: 'GitHub Projects',
        mark: 'github',
        detail: 'Classic token with read:project'
      }
    ],
    ...over
  };
}

/** The store's input for sources a test opened, at the first one's generation. */
export function opened(
  input: tickets.ConfiguredSource | tickets.ConfiguredSource[]
): backlog.TicketConnections {
  const sources = Array.isArray(input) ? input : [input];
  return { generation: sources[0]?.generation ?? 0, sources };
}
