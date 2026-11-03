import * as tickets from './tickets';

export const TICKET_TTL_MS = 60_000;
export type TicketStoreOptions = {
  onChange: () => void;
  onDetailClosed?: (requestId: string) => void;
  onSelection?: (selection: tickets.SavedTicketSelection) => void | Promise<void>;
  now?: () => number;
};

export class TicketStore {
  private detailRead:
    { requestId: string; key: string; url?: string; controller: AbortController } | undefined;
  private configured: tickets.ConfiguredSource | undefined;
  private saving: Promise<void> = Promise.resolve();
  private saved: tickets.SavedTicketSelection | undefined;
  private scopes: TicketScope[] | undefined;
  private scopeId: string | undefined;
  private selectionSeq = 0;
  private epoch = 0;
  private revision = 0;
  private disposed = false;
  private filter: TicketFilterView = tickets.defaultFilter();
  private snapshot: { tickets: TicketView[]; options: TicketOptions } | undefined;
  private error: tickets.TicketSourceError | undefined;
  private catalogAt: number | undefined;
  private optionsAt: number | undefined;
  private refreshOptions = false;
  private fetchedAt: number | undefined;
  private fetching = false;
  private again = false;
  private controller = new AbortController();
  private readonly now: () => number;

  constructor(private readonly ports: TicketStoreOptions) {
    this.now = ports.now ?? Date.now;
  }

  state(configured: tickets.ConfiguredSource | undefined): {
    tickets?: TicketView[];
    status?: TicketSourceStatus;
  } {
    if (this.disposed) return {};
    if (
      configured?.sourceId !== this.configured?.sourceId ||
      configured?.generation !== this.configured?.generation
    ) {
      this.reset();
      this.configured = configured;
    }
    if (!configured) return {};
    if (!this.fetching) {
      if (!this.scopes && this.due(this.catalogAt)) this.discover(configured);
      else if (this.scopeId && this.due(this.fetchedAt)) this.load(configured, this.scopeId);
    }
    return {
      tickets: this.snapshot?.tickets,
      status: {
        linked: true,
        sourceId: configured.sourceId,
        generation: configured.generation,
        selectionSeq: this.selectionSeq,
        scopeId: this.scopeId,
        scopes: this.scopes,
        presentation: configured.presentation,
        filter: this.filter,
        options: this.snapshot?.options,
        loading: this.fetching,
        stale: !!this.error,
        error: this.error?.message,
        failure: this.error?.kind
      }
    };
  }

  restoreSelection(selection: tickets.SavedTicketSelection): void {
    this.saved = selection;
  }

  identity(): TicketSelectionToken | undefined {
    return this.configured
      ? {
          generation: this.configured.generation,
          selectionSeq: this.selectionSeq,
          ...(this.scopeId ? { scopeId: this.scopeId } : {})
        }
      : undefined;
  }

  accepts(token: TicketSelectionToken): boolean {
    return (
      !this.disposed &&
      !!this.configured &&
      token.generation === this.configured.generation &&
      token.selectionSeq === this.selectionSeq &&
      token.scopeId === this.scopeId
    );
  }

  selectScope(
    scopeId: string,
    token: TicketSelectionToken
  ): tickets.SavedTicketSelection | undefined {
    const configured = this.configured;
    if (
      !configured ||
      this.disposed ||
      token.generation !== configured.generation ||
      !Number.isSafeInteger(token.selectionSeq) ||
      token.selectionSeq <= this.selectionSeq ||
      !this.scopes?.some((scope) => scope.id === scopeId)
    )
      return undefined;
    this.closeDetail();
    this.retire();
    this.selectionSeq = token.selectionSeq;
    this.scopeId = scopeId;
    this.snapshot = undefined;
    this.filter = tickets.defaultFilter();
    this.fetchedAt = undefined;
    this.optionsAt = undefined;
    this.error = undefined;
    return this.remember(configured.sourceId, scopeId);
  }

  setFilter(filter: TicketFilterView, token: TicketSelectionToken): TicketFilterView | undefined {
    if (!this.accepts(token) || !this.scopeId || !tickets.validFilter(filter)) return undefined;
    this.retire();
    this.filter = {
      assignee: filter.assignee,
      states: [...filter.states],
      priorities: [...filter.priorities]
    };
    this.refetch(false);
    return this.filter;
  }

  openTarget(key: string, token: TicketSelectionToken): string | undefined {
    return this.accepts(token)
      ? ((this.detailRead?.key === key ? this.detailRead.url : undefined) ??
          this.snapshot?.tickets.find((ticket) => ticket.key === key)?.url)
      : undefined;
  }

  async readDetail(
    key: string,
    token: TicketSelectionToken,
    requestId: string
  ): Promise<TicketDetail | undefined> {
    const configured = this.configured;
    if (
      !configured ||
      !this.accepts(token) ||
      !this.scopeId ||
      !requestId ||
      requestId.length > 100
    )
      return undefined;
    const known =
      this.snapshot?.tickets.some((row) => row.key === key) || this.detailRead?.key === key;
    let parts: unknown;
    try {
      parts = JSON.parse(key);
    } catch {
      return undefined;
    }
    if (
      !known ||
      !Array.isArray(parts) ||
      parts.length !== 2 ||
      parts[0] !== configured.sourceId ||
      typeof parts[1] !== 'string' ||
      !parts[1]
    )
      return undefined;
    this.closeDetail();
    const read = { requestId, key, controller: new AbortController() };
    this.detailRead = read;
    const result = await configured.source.detail(this.scopeId, parts[1], read.controller.signal);
    if (this.detailRead !== read) return undefined;
    if (result.key !== key || result.scopeId !== this.scopeId)
      throw new tickets.TicketSourceError('service', 'This ticket is no longer available here.');
    this.detailRead.url = result.url;
    return result;
  }

  detailCurrent(requestId: string): boolean {
    return this.detailRead?.requestId === requestId;
  }

  closeDetail(requestId?: string): void {
    const read = this.detailRead;
    if (!read || (requestId !== undefined && read.requestId !== requestId)) return;
    this.detailRead = undefined;
    read.controller.abort();
    this.ports.onDetailClosed?.(read.requestId);
  }

  refetch(options = true): void {
    if (options) {
      this.optionsAt = undefined;
      this.refreshOptions = true;
    }
    if (this.fetching) this.again = true;
    else {
      this.fetchedAt = undefined;
      if (!this.scopeId) {
        this.scopes = undefined;
        this.catalogAt = undefined;
      }
    }
  }

  reset(): void {
    this.closeDetail();
    this.retire();
    this.configured = undefined;
    this.scopes = undefined;
    this.scopeId = undefined;
    this.selectionSeq = 0;
    this.snapshot = undefined;
    this.filter = tickets.defaultFilter();
    this.error = undefined;
    this.catalogAt = undefined;
    this.fetchedAt = undefined;
    this.optionsAt = undefined;
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
  }

  private retire(): void {
    this.epoch++;
    this.revision++;
    this.controller.abort();
    this.controller = new AbortController();
    this.fetching = false;
    this.again = false;
    this.refreshOptions = false;
  }
  private due(at: number | undefined): boolean {
    return at === undefined || this.now() - at > TICKET_TTL_MS;
  }
  private remember(sourceId: string, scopeId: string): tickets.SavedTicketSelection {
    const selection = { sourceId, scopeId };
    this.saved = selection;
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        if (this.saved === selection) await this.ports.onSelection?.(selection);
      });
    void this.saving.catch(() => undefined);
    return selection;
  }
  private discover(configured: tickets.ConfiguredSource): void {
    const epoch = this.epoch;
    this.fetching = true;
    void (async () => configured.source.discoverScopes(this.controller.signal))()
      .then((scopes) => {
        if (epoch !== this.epoch) return;
        this.scopes = scopes;
        const saved = this.saved;
        const chosen = saved
          ? scopes.find(
              (scope) => saved.sourceId === configured.sourceId && saved.scopeId === scope.id
            )
          : (scopes.find((scope) => scope.key === configured.legacyTeamKey) ??
            (scopes.length === 1 ? scopes[0] : undefined));
        if (chosen) {
          this.scopeId = chosen.id;
          this.remember(configured.sourceId, chosen.id);
        }
        this.error = undefined;
      })
      .catch((error: unknown) => {
        if (epoch === this.epoch) this.error = tickets.sourceError(error);
      })
      .finally(() => {
        if (epoch !== this.epoch) return;
        this.catalogAt = this.again ? undefined : this.now();
        this.again = false;
        this.fetching = false;
        this.ports.onChange();
      });
  }
  private load(configured: tickets.ConfiguredSource, scopeId: string): void {
    const epoch = this.epoch;
    const revision = this.revision;
    const filter = this.filter;
    const signal = this.controller.signal;
    const cachedOptions = !this.due(this.optionsAt) ? this.snapshot?.options : undefined;
    this.refreshOptions = false;
    this.fetching = true;
    void Promise.all([
      (async () => configured.source.list(scopeId, filter, signal))(),
      cachedOptions
        ? Promise.resolve(cachedOptions)
        : (async () => configured.source.options(scopeId, signal))()
    ])
      .then(([rows, options]) => {
        if (epoch !== this.epoch || revision !== this.revision) return;
        this.snapshot = { tickets: rows.map(tickets.toTicketView), options };
        this.error = undefined;
        if (!cachedOptions && !this.refreshOptions) this.optionsAt = this.now();
      })
      .catch((error: unknown) => {
        if (epoch !== this.epoch) return;
        this.controller.abort();
        this.controller = new AbortController();
        if (revision === this.revision) this.error = tickets.sourceError(error);
      })
      .finally(() => {
        if (epoch !== this.epoch) return;
        this.fetchedAt = this.again || revision !== this.revision ? undefined : this.now();
        this.again = false;
        this.fetching = false;
        this.ports.onChange();
      });
  }
}
