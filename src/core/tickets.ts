export const SELECTION_KEY = 'tickets.selection';

export type SavedTicketSelection = { sourceId: string; scopeId: string };

export type Ticket = TicketView & {
  id: string;
  branchName?: string;
  assignee?: string;
};

export type TicketRead = { tickets: Ticket[]; options: TicketOptions; filter: TicketFilterView };

export interface TicketSource {
  invalidate?(): void;
  read?(scopeId: string, filter: TicketFilterView, signal?: AbortSignal): Promise<TicketRead>;
  discoverScopes(signal?: AbortSignal): Promise<TicketScope[]>;
  list(scopeId: string, filter: TicketFilterView, signal?: AbortSignal): Promise<Ticket[]>;
  detail(scopeId: string, id: string, signal?: AbortSignal): Promise<TicketDetail>;
  options(scopeId: string, signal?: AbortSignal): Promise<TicketOptions>;
}

export type ConfiguredSource = {
  sourceId: string;
  /** Changes whenever credentials or the configured source changes. */
  generation: number;
  source: TicketSource;
  presentation: TicketSourcePresentation;
  legacyTeamKey?: string;
  refreshMs?: number;
};

export function ticketKey(sourceId: string, nativeId: string): string {
  return JSON.stringify([sourceId, nativeId]);
}

export function toTicketView(ticket: Ticket): TicketView {
  return {
    scopeId: ticket.scopeId,
    key: ticket.key,
    identifier: ticket.identifier,
    title: ticket.title,
    priority: ticket.priority,
    state: ticket.state,
    url: ticket.url
  };
}

export function validFilter(raw: unknown): raw is TicketFilterView {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return (
    typeof value.assignee === 'string' &&
    Array.isArray(value.states) &&
    value.states.every((state: unknown) => typeof state === 'string') &&
    Array.isArray(value.priorities) &&
    value.priorities.every((priority: unknown) => typeof priority === 'string')
  );
}

export function defaultFilter(): TicketFilterView {
  return { assignee: 'anyone', states: [], priorities: [] };
}

export class TicketSourceError extends Error {
  constructor(
    readonly kind: 'credentials' | 'service',
    message: string
  ) {
    super(message);
  }
}
export function sourceError(error: unknown): TicketSourceError {
  return error instanceof TicketSourceError
    ? error
    : new TicketSourceError(
        'service',
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Could not load tickets. Please try again.'
      );
}
export function storedSelection(raw: unknown): SavedTicketSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  return typeof value.sourceId === 'string' &&
    !!value.sourceId &&
    typeof value.scopeId === 'string' &&
    !!value.scopeId
    ? { sourceId: value.sourceId, scopeId: value.scopeId }
    : undefined;
}

export function configuredEndpoint(
  scopes:
    { globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string } | undefined,
  fallback: string
): string {
  return scopes?.globalValue?.trim() || fallback;
}
