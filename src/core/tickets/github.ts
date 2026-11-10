import * as tickets from '../tickets';

export const SOURCE_ID = 'github';
// Required for the reason linear.ts gives.
export const PRESENTATION: Required<TicketSourcePresentation> = {
  label: 'GitHub',
  mark: 'github',
  reconfigureLabel: 'Update GitHub Projects credentials',
  disconnectLabel: 'Disconnect GitHub'
};
export const OFFER: TicketSourceOffer = {
  sourceId: SOURCE_ID,
  label: 'GitHub Projects',
  mark: 'github',
  detail: 'Classic token with read:project'
};
export const ENDPOINT = 'https://api.github.com/graphql';

/** The keychain record, stored as JSON. */
export type GithubRecord = { owner: string; token: string };

/** A GitHub organization or user login, or why the typed value is not one. */
export function ownerProblem(value: string): string | undefined {
  return /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(value.trim())
    ? undefined
    : 'Enter an organization or user login.';
}

/** A classic token, or why the typed value is not one. Fine-grained tokens cannot read ProjectV2. */
export function tokenProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('github_pat_'))
    return 'Use a personal access token (classic), not a fine-grained token.';
  return trimmed ? undefined : 'Enter your classic token.';
}

export const CONNECTOR: tickets.TicketConnector<GithubRecord> = {
  offer: OFFER,
  presentation: PRESENTATION,
  secretKey: 'squadron.github.connection',
  settingsSection: 'github',
  endpointSetting: 'github.endpoint',
  endpoint: (scopes) => tickets.configuredEndpoint(scopes, ENDPOINT),
  encode: (record) => JSON.stringify({ owner: record.owner, token: record.token }),
  decode: (raw) => {
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const value = record(parsed);
    return typeof value.owner === 'string' && typeof value.token === 'string'
      ? { owner: value.owner, token: value.token }
      : undefined;
  },
  open: (connection, context) => ({
    sourceId: SOURCE_ID,
    generation: context.generation,
    source: new GithubSource(connection.token, connection.owner, context.endpoint),
    presentation: PRESENTATION
  })
};
const PAGE = 'pageInfo { hasNextPage endCursor }';
const VALUES = `fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } } } ${PAGE} }`;
const PEOPLE = `assignees(first: 20) { nodes { id login } ${PAGE} }`;
const ITEM = `id type isArchived project { id } ${VALUES} content { __typename ... on Issue { id number title url repository { nameWithOwner } ${PEOPLE} } }`;
type RecordValue = Record<string, unknown>;
type Field = { id: string; options: TicketState[] };
type ProjectIssue = {
  row: tickets.Ticket;
  issueId: string;
  people: AssigneeOption[];
  description: string;
};

type ProjectSnapshot = { issues: ProjectIssue[]; options: TicketOptions };

export class GithubSource implements tickets.TicketSource {
  private snapshot: { scopeId: string; project: ProjectSnapshot } | undefined;
  private snapshotEpoch = 0;
  private viewerId: string | undefined;
  constructor(
    private readonly token: string,
    private readonly owner: string,
    private readonly endpoint = ENDPOINT
  ) {}

  async discoverScopes(signal?: AbortSignal): Promise<TicketScope[]> {
    const data = record(
      await this.query(
        `query GithubOwner($owner: String!) { repositoryOwner(login: $owner) { id __typename } viewer { id } }`,
        { owner: this.owner },
        signal
      )
    );
    const owner = record(data.repositoryOwner);
    if (
      typeof owner.id !== 'string' ||
      !['User', 'Organization'].includes(String(owner.__typename))
    )
      throw incomplete();
    this.viewerId = text(record(data.viewer).id);
    const nodes = await this.pages(
      `query GithubProjects($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2Owner { projectsV2(first: 100, after: $after) { nodes { id title number } ${PAGE} } } } }`,
      { id: owner.id },
      (d) => record(d.node).projectsV2,
      signal
    );
    return nodes
      .filter((n) => n !== null)
      .map((raw) => {
        const n = record(raw);
        if (
          typeof n.id !== 'string' ||
          typeof n.title !== 'string' ||
          !Number.isSafeInteger(n.number)
        )
          throw incomplete();
        return { id: n.id, key: String(n.number), label: n.title };
      });
  }

  async read(
    scopeId: string,
    requested: TicketFilterView,
    signal?: AbortSignal
  ): Promise<tickets.TicketRead> {
    signal?.throwIfAborted();
    const cached = this.snapshot;
    let project = cached?.scopeId === scopeId ? cached.project : undefined;
    if (!project) {
      this.snapshot = undefined;
      const epoch = this.snapshotEpoch;
      project = await this.readProject(scopeId, signal);
      signal?.throwIfAborted();
      if (epoch === this.snapshotEpoch) this.snapshot = { scopeId, project };
    }
    const { issues, options } = project;
    const filter = tickets.normalizeFilter(requested, options);
    const person = filter.assignee === 'me' ? this.viewerId : filter.assignee;
    const rows = issues
      .filter(
        (i) =>
          (person === 'anyone' ||
            (person === 'unassigned' ? !i.people.length : i.people.some((p) => p.id === person))) &&
          (!filter.states.length || filter.states.includes(i.row.state.value)) &&
          (!filter.priorities.length ||
            (!!i.row.priority && filter.priorities.includes(i.row.priority.value)))
      )
      .map((i) => i.row);
    return { tickets: rows, options, filter };
  }

  async detail(scopeId: string, id: string, signal?: AbortSignal): Promise<TicketDetail> {
    const [data, fields] = await Promise.all([
      this.query(
        `query GithubDetail($id: ID!) { node(id: $id) { ... on ProjectV2Item { ${ITEM} content { ... on Issue { body } } } } }`,
        { id },
        signal
      ),
      this.fields(scopeId, signal)
    ]);
    if (record(data.node).id !== id) throw unavailable();
    if (typeof record(record(data.node).content).body !== 'string') throw unavailable();
    const issue = await this.projectIssue(
      data.node,
      scopeId,
      resolveField(fields, 'status'),
      resolveField(fields, 'priority'),
      signal
    );
    if (!issue) throw unavailable();
    return {
      ...issue.row,
      description: issue.description,
      assignee: issue.people[0] ?? null,
      assignees: issue.people
    };
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.snapshotEpoch++;
  }

  private async readProject(scopeId: string, signal?: AbortSignal): Promise<ProjectSnapshot> {
    const [fields, items] = await Promise.all([
      this.fields(scopeId, signal),
      this.pages(
        `query GithubItems($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { items(first: 20, after: $after) { nodes { ${ITEM} } ${PAGE} } } } }`,
        { id: scopeId },
        (d) => record(d.node).items,
        signal
      )
    ]);
    if (!this.viewerId) {
      const viewer = await this.query('query GithubViewer { viewer { id } }', {}, signal);
      this.viewerId = text(record(viewer.viewer).id);
    }
    const status = resolveField(fields, 'status');
    const priority = resolveField(fields, 'priority');
    const issues: ProjectIssue[] = [];
    let hidden = 0;
    for (const item of items) {
      const value = record(item);
      if (value.isArchived === false && (value.type === 'REDACTED' || value.content === null))
        hidden++;
      const issue = await this.projectIssue(item, scopeId, status, priority, signal);
      if (issue) issues.push(issue);
    }
    const people = new Map<string, AssigneeOption>();
    for (const issue of issues) for (const person of issue.people) people.set(person.id, person);
    const options: TicketOptions = {
      scopeId,
      ...(hidden
        ? {
            accessWarning: `GitHub hid ${hidden === 1 ? '1 project item' : `${hidden} project items`}; its response does not identify the missing access. To read private issues, select the top-level repo scope on your classic token; repo:status, repo_deployment and repo:invite do not grant issue access. Your account must also have repository access. For organizations using SSO, authorize the token via Configure SSO. Squadron only reads projects and issues, but GitHub's repo scope also grants write access.`
          }
        : {}),
      assigneesComplete: true,
      viewerId: this.viewerId,
      assignees: [
        { id: 'anyone', label: 'Anyone' },
        { id: 'unassigned', label: 'Unassigned' },
        ...[...people.values()].sort((a, b) => a.label.localeCompare(b.label))
      ],
      states: status?.options ?? [],
      priorities: (priority?.options ?? []).map((p) => ({ ...p, tone: 'none' })),
      noStatusLane: !status || !status.options.length,
      prioritySort: { asc: 'Project order first', desc: 'Project order reversed' },
      unavailable: {
        ...(!status ? { states: missingField('Status') } : {}),
        ...(!priority ? { priorities: missingField('Priority') } : {})
      }
    };
    return { issues, options };
  }

  private fields(scopeId: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.pages(
      `query GithubFields($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2 { fields(first: 100, after: $after) { nodes { __typename ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { id name } } } ${PAGE} } } } }`,
      { id: scopeId },
      (d) => record(d.node).fields,
      signal
    );
  }
  private async projectIssue(
    raw: unknown,
    scopeId: string,
    status: Field | undefined,
    priority: Field | undefined,
    signal?: AbortSignal
  ): Promise<ProjectIssue | undefined> {
    if (raw === null) return undefined;
    const item = record(raw);
    const content = record(item.content);
    if (
      item.isArchived === true ||
      item.content === null ||
      (typeof content.__typename === 'string' && content.__typename !== 'Issue')
    )
      return undefined;
    if (item.isArchived !== false || record(item.project).id !== scopeId) throw unavailable();
    if (
      typeof item.id !== 'string' ||
      content.__typename !== 'Issue' ||
      typeof content.id !== 'string' ||
      typeof content.title !== 'string' ||
      (content.body !== undefined && typeof content.body !== 'string') ||
      typeof content.url !== 'string' ||
      !Number.isSafeInteger(content.number) ||
      typeof record(content.repository).nameWithOwner !== 'string'
    )
      throw incomplete();
    const values = await this.pages(
      `query GithubValues($id: ID!, $after: String) { node(id: $id) { ... on ProjectV2Item { fieldValues(first: 100, after: $after) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2FieldCommon { id } } } } ${PAGE} } } } }`,
      { id: item.id },
      (d) => record(d.node).fieldValues,
      signal,
      item.fieldValues
    );
    const assignees = await this.pages(
      `query GithubAssignees($id: ID!, $after: String) { node(id: $id) { ... on Issue { assignees(first: 100, after: $after) { nodes { id login } ${PAGE} } } } }`,
      { id: content.id },
      (d) => record(d.node).assignees,
      signal,
      content.assignees
    );
    const people = assignees.map((rawPerson) => {
      const p = record(rawPerson);
      if (typeof p.id !== 'string' || typeof p.login !== 'string') throw incomplete();
      return { id: p.id, label: p.login };
    });
    const option = (field: Field | undefined): TicketState | undefined => {
      if (!field) return undefined;
      const value = values.map(record).find((v) => record(v.field).id === field.id);
      return field.options.find((o) => o.value === value?.optionId);
    };
    const rank = option(priority);
    return {
      issueId: content.id,
      people,
      description: typeof content.body === 'string' ? content.body : '',
      row: {
        id: item.id,
        scopeId,
        key: tickets.ticketKey(SOURCE_ID, item.id),
        identifier: `${String(record(content.repository).nameWithOwner)}#${String(content.number)}`,
        title: content.title,
        url: content.url,
        state: option(status) ?? { value: '', label: 'No status' },
        ...(rank ? { priority: { ...rank, tone: 'none' } } : {})
      }
    };
  }
  private async pages(
    query: string,
    variables: RecordValue,
    connection: (data: RecordValue) => unknown,
    signal?: AbortSignal,
    initial?: unknown
  ): Promise<unknown[]> {
    const nodes: unknown[] = [];
    const cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 1000; page++) {
      signal?.throwIfAborted();
      const value = record(
        page === 0 && initial !== undefined
          ? initial
          : connection(await this.query(query, { ...variables, after }, signal))
      );
      const info = record(value.pageInfo);
      if (!Array.isArray(value.nodes) || typeof info.hasNextPage !== 'boolean') throw incomplete();
      nodes.push(...(value.nodes as unknown[]));
      if (!info.hasNextPage) return nodes;
      if (typeof info.endCursor !== 'string' || !info.endCursor || cursors.has(info.endCursor))
        throw incomplete();
      after = info.endCursor;
      cursors.add(after);
    }
    throw incomplete();
  }
  private async query(
    query: string,
    variables: RecordValue,
    signal?: AbortSignal
  ): Promise<RecordValue> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query, variables }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000)
    });
    const json = record(await response.json().catch(() => undefined));
    const errors = Array.isArray(json.errors)
      ? json.errors.map(record).filter((error) => !inaccessibleContent(error, json.data))
      : [];
    if (!response.ok || errors.length) {
      const message =
        errors
          .map((e) => e.message)
          .filter((m): m is string => typeof m === 'string' && !!m.trim())
          .join('; ') ||
        text(json.message) ||
        `GitHub responded ${response.status} ${response.statusText}`;
      throw new tickets.TicketSourceError(
        response.status === 401 ? 'credentials' : 'service',
        message
      );
    }
    if (!json.data || typeof json.data !== 'object') throw incomplete();
    return record(json.data);
  }
}
function resolveField(fields: unknown[], name: string): Field | undefined {
  const matches = fields
    .map(record)
    .filter((f) => typeof f.name === 'string' && f.name.toLowerCase() === name);
  const f = matches.length === 1 ? matches[0] : undefined;
  if (
    !f ||
    f.__typename !== 'ProjectV2SingleSelectField' ||
    typeof f.id !== 'string' ||
    !Array.isArray(f.options)
  )
    return undefined;
  const options: TicketState[] = [];
  for (const raw of f.options) {
    const o = record(raw);
    if (
      typeof o.id !== 'string' ||
      typeof o.name !== 'string' ||
      options.some((p) => p.value === o.id)
    )
      return undefined;
    options.push({ value: o.id, label: o.name, order: options.length });
  }
  return { id: f.id, options };
}
function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function incomplete(): tickets.TicketSourceError {
  return new tickets.TicketSourceError('service', 'GitHub returned an incomplete response.');
}
function unavailable(): tickets.TicketSourceError {
  return new tickets.TicketSourceError(
    'service',
    'This project issue is no longer available here.'
  );
}
function missingField(name: string): string {
  return `No usable single-select field named "${name}" was found in this project.`;
}

function inaccessibleContent(error: RecordValue, data: unknown): boolean {
  if (error.type !== 'FORBIDDEN' && error.type !== 'NOT_FOUND') return false;
  const path = error.path;
  if (
    !Array.isArray(path) ||
    path.length !== 5 ||
    path[0] !== 'node' ||
    path[1] !== 'items' ||
    path[2] !== 'nodes' ||
    path[4] !== 'content'
  )
    return false;
  const index: unknown = path[3];
  const nodes = record(record(record(data).node).items).nodes;
  return (
    typeof index === 'number' &&
    Number.isSafeInteger(index) &&
    index >= 0 &&
    Array.isArray(nodes) &&
    index < nodes.length &&
    record(nodes[index]).content === null
  );
}
