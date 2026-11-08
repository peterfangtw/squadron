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
  private sources: tickets.ConfiguredSource[] = [];
  private catalogs = new Map<
    string,
    { scopes?: TicketScope[]; error?: tickets.TicketSourceError; at?: number }
  >();
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
  private catalogEpoch = 0;
  private catalogController = new AbortController();
  private catalogReads = new Set<string>();
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

  state(input: tickets.ConfiguredSource | tickets.ConfiguredSource[] | undefined): {
    tickets?: TicketView[];
    status?: TicketSourceStatus;
  } {
    if (this.disposed) return {};
    const sources = input ? (Array.isArray(input) ? input : [input]) : [];
    if (
      JSON.stringify(sources.map((s) => [s.sourceId, s.generation])) !==
      JSON.stringify(this.sources.map((s) => [s.sourceId, s.generation]))
    ) {
      this.reset();
      this.sources = sources;
      this.configured = sources.find((s) => s.sourceId === this.saved?.sourceId) ?? sources[0];
    }
    const configured = this.configured;
    if (!configured) return {};
    for (const source of this.sources) {
      if (
        !this.catalogReads.has(source.sourceId) &&
        this.due(
          this.catalogs.get(source.sourceId)?.at,
          this.catalogs.get(source.sourceId)?.error ? TICKET_TTL_MS : (source.refreshMs ?? Infinity)
        )
      )
        this.discover(source);
    }
    if (
      !this.fetching &&
      this.scopeId &&
      !this.catalogs.get(configured.sourceId)?.error &&
      this.due(this.fetchedAt, configured.refreshMs)
    )
      this.load(configured, this.scopeId);
    const error = this.catalogs.get(configured.sourceId)?.error ?? this.error;
    return {
      tickets: this.snapshot?.tickets,
      status: {
        linked: true,
        ...(this.sources.length > 1
          ? {
              boards: this.sources.flatMap((source) =>
                (this.catalogs.get(source.sourceId)?.scopes ?? []).map((scope) => ({
                  ...scope,
                  sourceId: source.sourceId,
                  presentation: source.presentation
                }))
              )
            }
          : {}),
        connections: this.sources.map((source) => ({
          sourceId: source.sourceId,
          presentation: source.presentation,
          error: this.catalogs.get(source.sourceId)?.error?.message,
          failure: this.catalogs.get(source.sourceId)?.error?.kind
        })),
        sourceId: configured.sourceId,
        generation: configured.generation,
        selectionSeq: this.selectionSeq,
        scopeId: this.scopeId,
        scopes: this.scopes,
        presentation: configured.presentation,
        filter: this.filter,
        options: this.snapshot?.options,
        loading: this.fetching || (!this.scopes && this.catalogReads.has(configured.sourceId)),
        stale: !!error,
        error: error?.message,
        failure: error?.kind
      }
    };
  }

  restoreSelection(selection: tickets.SavedTicketSelection): void {
    this.saved = selection;
  }

  identity(): TicketSelectionToken | undefined {
    return this.configured
      ? {
          ...(this.sources.length > 1 ? { sourceId: this.configured.sourceId } : {}),
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
      (token.sourceId === undefined || token.sourceId === this.configured.sourceId) &&
      token.generation === this.configured.generation &&
      token.selectionSeq === this.selectionSeq &&
      token.scopeId === this.scopeId
    );
  }

  selectScope(
    scopeId: string,
    token: TicketSelectionToken
  ): tickets.SavedTicketSelection | undefined {
    const configured = token.sourceId
      ? this.sources.find((s) => s.sourceId === token.sourceId)
      : this.configured;
    const scopes = configured ? this.catalogs.get(configured.sourceId)?.scopes : undefined;
    if (
      !configured ||
      this.disposed ||
      token.generation !== configured.generation ||
      !Number.isSafeInteger(token.selectionSeq) ||
      token.selectionSeq <= this.selectionSeq ||
      !(scopes ?? this.scopes)?.some((scope) => scope.id === scopeId)
    )
      return undefined;
    this.closeDetail();
    this.configured?.source.invalidate?.();
    this.retire();
    this.configured = configured;
    this.scopes = scopes ?? this.scopes;
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

  refetchCatalog(): void {
    for (const source of this.sources) source.source.invalidate?.();
    this.retire();
    this.catalogEpoch++;
    this.catalogController.abort();
    this.catalogController = new AbortController();
    this.catalogReads.clear();
    for (const catalog of this.catalogs.values()) catalog.at = undefined;
    this.fetchedAt = undefined;
    this.optionsAt = undefined;
  }

  refetch(options = true): void {
    if (options) {
      this.configured?.source.invalidate?.();
      this.optionsAt = undefined;
      this.refreshOptions = true;
    }
    if (this.fetching) this.again = true;
    else {
      this.fetchedAt = undefined;
      if (!this.scopeId) {
        this.scopes = undefined;
        if (this.configured) this.catalogs.delete(this.configured.sourceId);
      }
    }
  }

  reset(): void {
    for (const source of this.sources) source.source.invalidate?.();
    this.closeDetail();
    this.retire();
    this.configured = undefined;
    this.sources = [];
    this.catalogs.clear();
    this.catalogEpoch++;
    this.catalogController.abort();
    this.catalogController = new AbortController();
    this.catalogReads.clear();
    this.scopes = undefined;
    this.scopeId = undefined;
    this.selectionSeq = 0;
    this.snapshot = undefined;
    this.filter = tickets.defaultFilter();
    this.error = undefined;
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
  private due(at: number | undefined, ttl = TICKET_TTL_MS): boolean {
    return at === undefined || this.now() - at > ttl;
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
    const epoch = this.catalogEpoch;
    const sourceId = configured.sourceId;
    this.catalogReads.add(sourceId);
    void (async () => configured.source.discoverScopes(this.catalogController.signal))()
      .then((scopes) => ({
        scopes,
        at: this.now(),
        error: undefined as tickets.TicketSourceError | undefined
      }))
      .catch((error: unknown) => ({
        scopes: this.catalogs.get(sourceId)?.scopes,
        at: this.now(),
        error: tickets.sourceError(error)
      }))
      .then((catalog) => {
        if (epoch !== this.catalogEpoch) return;
        this.catalogReads.delete(sourceId);
        this.catalogs.set(sourceId, catalog);
        this.resolveCatalog(sourceId);
        this.ports.onChange();
      });
  }
  private resolveCatalog(changedSourceId: string): void {
    let configured = this.configured;
    if (!configured) return;
    let catalog = this.catalogs.get(configured.sourceId);
    if (configured.sourceId === changedSourceId) {
      this.scopes = catalog?.scopes;
      if (catalog?.error) return;
      if (this.scopeId && !this.scopes?.some((scope) => scope.id === this.scopeId)) {
        this.closeDetail();
        this.retire();
        this.scopeId = undefined;
        this.snapshot = undefined;
        this.filter = tickets.defaultFilter();
        this.selectionSeq++;
      }
    }
    if (this.scopeId || !catalog?.scopes) return;
    const sourceId = configured.sourceId;
    const legacyTeamKey = configured.legacyTeamKey;
    let chosen = this.saved
      ? catalog.scopes.find(
          (scope) => this.saved?.sourceId === sourceId && this.saved.scopeId === scope.id
        )
      : catalog.scopes.find((scope) => scope.key === legacyTeamKey);
    if (
      !chosen &&
      !this.saved &&
      this.sources.every((source) => {
        const value = this.catalogs.get(source.sourceId);
        return value?.scopes && value.at !== undefined && !value.error;
      })
    ) {
      const boards = this.sources.flatMap((source) =>
        (this.catalogs.get(source.sourceId)?.scopes ?? []).map((scope) => ({ source, scope }))
      );
      if (boards.length === 1 && boards[0]) {
        configured = boards[0].source;
        chosen = boards[0].scope;
        this.configured = configured;
        catalog = this.catalogs.get(configured.sourceId);
        this.scopes = catalog?.scopes;
      }
    }
    if (chosen) {
      this.scopeId = chosen.id;
      this.error = undefined;
      this.remember(configured.sourceId, chosen.id);
    }
  }
  private load(configured: tickets.ConfiguredSource, scopeId: string): void {
    const epoch = this.epoch;
    const revision = this.revision;
    const filter = this.filter;
    const signal = this.controller.signal;
    const cachedOptions = !this.due(this.optionsAt) ? this.snapshot?.options : undefined;
    this.refreshOptions = false;
    this.fetching = true;
    const pending = configured.source.read
      ? configured.source.read(scopeId, filter, signal)
      : Promise.all([
          (async () => configured.source.list(scopeId, filter, signal))(),
          cachedOptions
            ? Promise.resolve(cachedOptions)
            : (async () => configured.source.options(scopeId, signal))()
        ]).then(([rows, options]) => ({ tickets: rows, options, filter }));
    void pending
      .then((result) => {
        if (epoch !== this.epoch || revision !== this.revision) return;
        this.snapshot = {
          tickets: result.tickets.map(tickets.toTicketView),
          options: result.options
        };
        this.filter = result.filter;
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
