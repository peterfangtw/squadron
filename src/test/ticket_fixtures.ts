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
    generation: 1,
    selectionSeq: 0,
    scopeId: 'team-a',
    scopes: [
      { id: 'team-a', key: 'ENG', label: 'Engineering' },
      { id: 'team-b', key: 'OPS', label: 'Operations' }
    ],
    presentation: {
      label: 'Linear',
      mark: 'linear',
      connectLabel: 'Connect Linear',
      connectHint: 'Connect Linear to see your backlog here.',
      reconfigureLabel: 'Paste a different Linear API key'
    },
    ...over
  };
}
