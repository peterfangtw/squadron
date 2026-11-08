import * as tickets from '../tickets';

export const SOURCE_ID = 'linear';

export const PRESENTATION: TicketSourcePresentation = {
  label: 'Linear',
  mark: 'linear',
  connectLabel: 'Connect Linear',
  connectHint: 'Connect Linear to see your backlog here.',
  reconfigureLabel: 'Paste a different Linear API key'
};

export function priorityValue(value: number): TicketPriority {
  const scale: TicketTone[] = ['none', 'urgent', 'high', 'medium', 'low'];
  const valid = Number.isInteger(value) && value >= 0 && value <= 4 ? value : 0;
  return {
    value: String(valid),
    label: priorityName(valid),
    order: urgency(valid),
    tone: scale[valid] ?? 'none'
  };
}

/** Linear's priority scale, index = `priority.value`. */
const PRIORITY_NAMES = ['None', 'Urgent', 'High', 'Medium', 'Low'];

export function priorityName(value: number): string {
  return PRIORITY_NAMES[value] ?? 'None';
}

export function urgency(priority: number): number {
  return priority || 5;
}

export const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';

/**
 * Where the tracker's GraphQL lives, from the settings scopes a host reports.
 *
 * Only the user's own value counts. The setting is undeclared in
 * `package.json`, so it has no configuration scope of its own — which without
 * this would leave `.vscode/settings.json` in a cloned repo able to name the
 * host every ticket fetch is POSTed to, and the key rides those requests in an
 * `Authorization` header. A repo may say where its dev server listens; it may
 * not say where the reader's credential is sent.
 *
 * The user scope stays open because `test/smoke` writes it into the throwaway
 * profile it launches, pointing a real host at a canned reply on localhost so
 * the suite that gates every deploy needs no Linear account.
 */
export function trackerEndpoint(
  scopes:
    { globalValue?: string; workspaceValue?: string; workspaceFolderValue?: string } | undefined
): string {
  return tickets.configuredEndpoint(scopes, LINEAR_ENDPOINT);
}

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';

/** Linear orders only by createdAt/updatedAt; a stable local priority sort preserves that tie order. */
const ISSUES_QUERY = `
query Backlog($filter: IssueFilter!, $after: String) {
  issues(filter: $filter, first: 100, after: $after, includeArchived: false, orderBy: updatedAt) {
    nodes {
      id identifier title priority url branchName
      state { id name type }
      assignee { displayName }
    }
    ${PAGE_INFO}
  }
}`;

/** The GraphQL `IssueFilter` for a `TicketFilter`, built from values not strings. */
export function issueFilter(filter: TicketFilterView, scopeId: string): Record<string, unknown> {
  if (!scopeId || !filter.priorities.every((value) => /^[0-4]$/.test(value)))
    throw new Error('Invalid Linear ticket filter');
  const out: Record<string, unknown> = {};
  if (filter.states.length > 0) {
    out.state = {
      id: { in: filter.states }
    };
  }
  if (filter.assignee === 'me') {
    out.assignee = { isMe: { eq: true } };
  } else if (filter.assignee === 'unassigned') {
    out.assignee = { null: true };
  } else if (filter.assignee !== 'anyone') {
    out.assignee = { id: { eq: filter.assignee } };
  }
  if (filter.priorities.length > 0) {
    const priorities = filter.priorities.map(Number);
    out.priority = { in: priorities };
  }
  out.team = { id: { eq: scopeId } };
  return out;
}

const TEAMS_QUERY = `query TicketScopes($after: String) { teams(first: 100, after: $after) { nodes { id key name } ${PAGE_INFO} } }`;
const MEMBERS_QUERY = `query TicketMembers($scopeId: String!, $after: String) { team(id: $scopeId) { members(first: 100, after: $after, filter: { active: { eq: true } }) { nodes { id displayName name } ${PAGE_INFO} } } }`;
const STATES_QUERY = `query TicketStates($scopeId: String!, $after: String) { team(id: $scopeId) { states(first: 100, after: $after) { nodes { id name type position } ${PAGE_INFO} } } }`;
const OPTIONS_QUERY = `query TicketOptions { viewer { id displayName name } issuePriorityValues { priority label } }`;

/** Display order for the state chips: the flow a ticket travels, left to right. */
const STATE_TYPE_RANK: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5
};

/** People and workflow identities belong to the selected team; labels are presentation only. */
export function toOptions(data: unknown, scopeId: string): TicketOptions {
  const d = data as {
    viewer?: unknown;
    users?: { nodes?: unknown[] };
    workflowStates?: { nodes?: unknown[] };
    issuePriorityValues?: unknown[];
  };

  const users = Array.isArray(d?.users?.nodes) ? d.users.nodes : [];
  const people = new Map<string, AssigneeOption>();
  const viewer = d?.viewer as { id?: unknown } | undefined;
  const viewerId = typeof viewer?.id === 'string' ? viewer.id : undefined;
  for (const raw of users) {
    if (!raw || typeof raw !== 'object') continue;
    const u = raw as { id?: unknown; displayName?: unknown; name?: unknown };
    if (typeof u.id !== 'string' || !u.id) continue;
    if (people.has(u.id)) continue;
    const label =
      typeof u.displayName === 'string' && u.displayName
        ? u.displayName
        : typeof u.name === 'string' && u.name
          ? u.name
          : u.id;
    people.set(u.id, { id: u.id, label });
  }
  const assignees: AssigneeOption[] = [
    { id: 'anyone', label: 'Anyone' },
    { id: 'unassigned', label: 'Unassigned' },
    ...[...people.values()].sort((a, b) => a.label.localeCompare(b.label))
  ];

  const nodes = Array.isArray(d?.workflowStates?.nodes) ? d.workflowStates.nodes : [];
  const byId = new Map<string, StateOption & { type: string; position: number }>();
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as { id?: unknown; name?: unknown; type?: unknown; position?: unknown };
    if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.type !== 'string')
      continue;
    if (!byId.has(s.id)) {
      byId.set(s.id, {
        value: s.id,
        label: s.name,
        order: 0,
        type: s.type,
        position: typeof s.position === 'number' ? s.position : 0
      });
    }
  }
  const states = [...byId.values()]
    .sort((a, b) => {
      const rank = (STATE_TYPE_RANK[a.type] ?? 9) - (STATE_TYPE_RANK[b.type] ?? 9);
      return rank !== 0 ? rank : a.position - b.position;
    })
    .map(({ value, label }, order) => ({ value, label, order }));

  // The scale, named by Linear rather than by a table here. Ordered by urgency,
  // not by value, so the menu reads Urgent → No priority the way the tracker's
  // own does. An absent or malformed entry is skipped, not defaulted: a menu row
  // that mislabels a priority filters to something other than what it says.
  const scale = Array.isArray(d?.issuePriorityValues) ? d.issuePriorityValues : [];
  const priorities: PriorityOption[] = [];
  for (const raw of scale) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { priority?: unknown; label?: unknown };
    if (
      typeof p.priority !== 'number' ||
      !Number.isInteger(p.priority) ||
      p.priority < 0 ||
      p.priority > 4 ||
      typeof p.label !== 'string'
    )
      continue;
    priorities.push({ ...priorityValue(p.priority), label: p.label });
  }
  priorities.sort((a, b) => a.order - b.order);

  return { scopeId, ...(viewerId ? { viewerId } : {}), assignees, states, priorities };
}

/**
 * The pure half: a Linear `issues` response -> `Ticket[]`. Nodes missing the
 * fields a card needs are skipped rather than rendered half-blank. Kept separate
 * from the fetch so it can be tested without a network.
 */
export function toTickets(
  data: unknown,
  scopeId: string,
  sourceId = SOURCE_ID
): (tickets.Ticket & { priority: TicketPriority })[] {
  const nodes = (data as { issues?: { nodes?: unknown[] } })?.issues?.nodes;
  if (!Array.isArray(nodes)) return [];

  const rows: (tickets.Ticket & { priority: TicketPriority })[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const n = raw as {
      id?: unknown;
      identifier?: unknown;
      title?: unknown;
      priority?: unknown;
      url?: unknown;
      branchName?: unknown;
      state?: { id?: unknown; name?: unknown; type?: unknown };
      assignee?: { displayName?: unknown };
    };
    if (typeof n.id !== 'string' || typeof n.identifier !== 'string') continue;
    if (typeof n.title !== 'string' || typeof n.url !== 'string') continue;

    const priority = typeof n.priority === 'number' ? n.priority : 0;
    rows.push({
      scopeId,
      id: n.id,
      key: tickets.ticketKey(sourceId, n.id),
      identifier: n.identifier,
      title: n.title,
      priority: priorityValue(priority),
      state: {
        value: typeof n.state?.id === 'string' ? n.state.id : '',
        label: typeof n.state?.name === 'string' ? n.state.name : ''
      },
      url: n.url,
      branchName: typeof n.branchName === 'string' ? n.branchName : undefined,
      assignee: typeof n.assignee?.displayName === 'string' ? n.assignee.displayName : undefined
    });
  }
  return rows;
}

/** Linear's key and user-scoped endpoint are supplied by the host. */
export class LinearSource implements tickets.TicketSource {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string = LINEAR_ENDPOINT,
    private readonly sourceId = SOURCE_ID
  ) {}

  async discoverScopes(signal?: AbortSignal): Promise<TicketScope[]> {
    signal = readSignal(signal);
    const nodes = await this.pages(TEAMS_QUERY, {}, (data) => record(data).teams, signal);
    const scopes = new Map<string, TicketScope>();
    for (const raw of nodes) {
      const node = record(raw);
      if (
        typeof node.id !== 'string' ||
        !node.id ||
        typeof node.key !== 'string' ||
        typeof node.name !== 'string'
      )
        throw incomplete();
      scopes.set(node.id, { id: node.id, key: node.key, label: node.name });
    }
    return [...scopes.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  async list(
    scopeId: string,
    filter: TicketFilterView,
    signal?: AbortSignal
  ): Promise<tickets.Ticket[]> {
    const nodes = await this.pages(
      ISSUES_QUERY,
      { filter: issueFilter(filter, scopeId) },
      (data) => record(data).issues,
      signal
    );
    const rows = toTickets({ issues: { nodes } }, scopeId, this.sourceId);
    return [...new Map(rows.map((row) => [row.id, row])).values()];
  }

  async detail(scopeId: string, id: string, signal?: AbortSignal): Promise<TicketDetail> {
    const data = record(
      await this.query(
        `query TicketDetail($id: String!) {
      issue(id: $id) {
        id identifier title url description
        team { id }
        state { id name }
        assignee { id displayName name }
      }
    }`,
        { id },
        signal
      )
    );
    const issue = record(data.issue);
    const state = record(issue.state);
    const person = record(issue.assignee);
    if (
      issue.id !== id ||
      record(issue.team).id !== scopeId ||
      typeof issue.identifier !== 'string' ||
      typeof issue.title !== 'string' ||
      typeof issue.url !== 'string' ||
      typeof state.id !== 'string' ||
      typeof state.name !== 'string' ||
      !(issue.description === null || typeof issue.description === 'string') ||
      !(
        issue.assignee === null ||
        (typeof person.id === 'string' &&
          (typeof person.displayName === 'string' || typeof person.name === 'string'))
      )
    )
      throw incomplete();
    return {
      key: tickets.ticketKey(this.sourceId, id),
      scopeId,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      state: { value: state.id, label: state.name },
      assignee:
        issue.assignee === null
          ? null
          : {
              id: person.id as string,
              label: (person.displayName || person.name) as string
            },
      description: issue.description ?? ''
    };
  }

  async options(scopeId: string, signal?: AbortSignal): Promise<TicketOptions> {
    signal = readSignal(signal);
    if (!scopeId) throw incomplete();
    const [users, states, meta] = await Promise.all([
      this.pages(MEMBERS_QUERY, { scopeId }, (data) => record(record(data).team).members, signal),
      this.pages(STATES_QUERY, { scopeId }, (data) => record(record(data).team).states, signal),
      this.query(OPTIONS_QUERY, {}, signal)
    ]);
    const data = record(meta);
    if (typeof record(data.viewer).id !== 'string' || !Array.isArray(data.issuePriorityValues))
      throw incomplete();
    for (const user of users) if (typeof record(user).id !== 'string') throw incomplete();
    for (const state of states) {
      const s = record(state);
      if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.type !== 'string')
        throw incomplete();
    }
    return toOptions(
      { ...data, users: { nodes: users }, workflowStates: { nodes: states } },
      scopeId
    );
  }

  private async pages(
    query: string,
    variables: Record<string, unknown>,
    connection: (data: unknown) => unknown,
    signal?: AbortSignal
  ): Promise<unknown[]> {
    const nodes: unknown[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    // A pathological cursor stream must fail rather than silently truncate a catalog.
    for (let page = 0; page < 1000; page++) {
      const data = await this.query(query, { ...variables, after }, signal);
      const value = record(connection(data));
      const info = record(value.pageInfo);
      if (!Array.isArray(value.nodes) || typeof info.hasNextPage !== 'boolean') throw incomplete();
      nodes.push(...(value.nodes as unknown[]));
      if (!info.hasNextPage) return nodes;
      if (typeof info.endCursor !== 'string' || !info.endCursor || seen.has(info.endCursor))
        throw incomplete();
      after = info.endCursor;
      seen.add(after);
    }
    throw incomplete();
  }

  private async query(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.apiKey },
        body: JSON.stringify({ query, variables }),
        signal: readSignal(signal)
      });
      const json = record(await res.json().catch(() => undefined));
      const errors = Array.isArray(json.errors) ? json.errors.map(record) : [];
      if (!res.ok || errors.length) {
        const rejected =
          res.status === 401 ||
          errors.some((error) => {
            const extension = record(error.extensions);
            return (
              extension.code === 'UNAUTHENTICATED' ||
              extension.code === 'AUTHENTICATION_ERROR' ||
              extension.type === 'authentication error'
            );
          });
        const messages = errors
          .map((error) => error.message)
          .filter((message): message is string => typeof message === 'string' && !!message.trim());
        if (!messages.length && typeof json.message === 'string') messages.push(json.message);
        throw new tickets.TicketSourceError(
          rejected ? 'credentials' : 'service',
          messages.length ? messages.join('; ') : `Linear responded ${res.status} ${res.statusText}`
        );
      }
      if (!json.data || typeof json.data !== 'object') throw incomplete();
      return json.data;
    } catch (error) {
      throw tickets.sourceError(error);
    }
  }
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
function incomplete(): tickets.TicketSourceError {
  return new tickets.TicketSourceError('service', 'Linear returned an incomplete response.');
}

function readSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
}
