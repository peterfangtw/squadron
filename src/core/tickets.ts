export const SELECTION_KEY = 'tickets.selection';

export type SavedTicketSelection = { sourceId: string; scopeId: string };

export type Ticket = TicketView & {
  id: string;
  branchName?: string;
  assignee?: string;
};

export type TicketRead = { tickets: Ticket[]; options: TicketOptions; filter: TicketFilterView };

/**
 * One read protocol: `read` answers a scope's rows and options together, its
 * filter normalised against those options; what a source caches between reads
 * is its own, and `invalidate` drops all of it.
 */
export interface TicketSource {
  /** Drop whatever the source cached. The store calls it when its TTL lapses or on Refresh. */
  invalidate(): void;
  read(scopeId: string, filter: TicketFilterView, signal?: AbortSignal): Promise<TicketRead>;
  discoverScopes(signal?: AbortSignal): Promise<TicketScope[]>;
  detail(scopeId: string, id: string, signal?: AbortSignal): Promise<TicketDetail>;
}

export type ConfiguredSource = {
  sourceId: string;
  /** Changes whenever credentials or the configured source changes. */
  generation: number;
  source: TicketSource;
  presentation: TicketSourcePresentation;
  legacyTeamKey?: string;
};

/** The host's reads a source's `open` may take, beyond its own record. */
export type OpenContext = {
  /** The endpoint `TicketConnector.endpoint` chose from the setting's scopes. */
  endpoint: string;
  generation: number;
  /** A `squadron.*` setting, by its key under that section. */
  setting(key: string): string | undefined;
};

/** The settings scopes a host reports for one key (`inspect`). */
export type SettingScopes =
  { globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string } | undefined;

/**
 * One source's connection rules, `vscode`-free: what it offers, where its
 * credential lives and how that record reads, and how a record becomes a
 * `ConfiguredSource`. The host keeps the prompts, the keychain and the
 * watches. `R` is the decoded keychain record.
 */
export interface TicketConnector<R extends object = object> {
  offer: TicketSourceOffer;
  presentation: Required<TicketSourcePresentation>;
  /** The keychain (SecretStorage) key the record is stored under. */
  secretKey: string;
  /** The `squadron.*` section whose change resets tickets, e.g. `linear`. */
  settingsSection: string;
  /** The `squadron.*` key a user may point the endpoint at. */
  endpointSetting: string;
  endpoint(scopes: SettingScopes): string;
  encode(record: R): string;
  /** A missing or malformed record is disconnected, never a throw. */
  decode(raw: string | undefined): R | undefined;
  open(record: R, context: OpenContext): ConfiguredSource;
}

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

/** The assignee words every source answers without a person row. */
const ASSIGNEE_WORDS = ['anyone', 'unassigned', 'me'];

/**
 * A filter with every choice the options no longer offer pruned: states and
 * priorities always, an assignee only when `assigneesComplete` says a missing
 * person is gone rather than unlisted.
 */
export function normalizeFilter(
  filter: TicketFilterView,
  options: TicketOptions
): TicketFilterView {
  return {
    assignee:
      options.assigneesComplete &&
      !ASSIGNEE_WORDS.includes(filter.assignee) &&
      !options.assignees.some((person) => person.id === filter.assignee)
        ? 'anyone'
        : filter.assignee,
    states: filter.states.filter((id) => options.states.some((s) => s.value === id)),
    priorities: filter.priorities.filter((id) => options.priorities.some((p) => p.value === id))
  };
}

/** Whether `normalizeFilter` could change this filter under any options. */
export function prunable(filter: TicketFilterView): boolean {
  return (
    filter.states.length > 0 ||
    filter.priorities.length > 0 ||
    !ASSIGNEE_WORDS.includes(filter.assignee)
  );
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

export function configuredEndpoint(scopes: SettingScopes, fallback: string): string {
  return scopes?.globalValue?.trim() || fallback;
}
