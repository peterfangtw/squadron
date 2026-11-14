import * as tickets from '../tickets';

/** One public entry's ceiling. A single POST still dies at `REQUEST_MS`. */
export const WALK_MS = 30_000;
export const REQUEST_MS = 15_000;

/**
 * The caller's abort and the walk budget, as one signal. Nested reads reuse
 * this signal; they do not start another budget.
 */
export function walkSignal(caller?: AbortSignal, budgetMs = WALK_MS): AbortSignal {
  const budget = AbortSignal.timeout(budgetMs);
  return caller ? AbortSignal.any([caller, budget]) : budget;
}

export async function graphqlRequest(input: {
  endpoint: string;
  authorization: string;
  query: string;
  variables: Record<string, unknown>;
  signal: AbortSignal;
  requestMs?: number;
  /** HTTP status and the GraphQL errors that survived `filterError`. */
  credentials: (status: number, errors: Record<string, unknown>[]) => boolean;
  /** Return true to drop an error the source tolerates. */
  filterError?: (error: Record<string, unknown>, data: unknown) => boolean;
  fallback: (status: number, statusText: string) => string;
  fail: () => tickets.TicketSourceError;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: input.authorization },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.requestMs ?? REQUEST_MS)])
    });
  } catch (error) {
    throw tickets.sourceError(error);
  }
  const json = record(await response.json().catch(() => undefined));
  const listed = Array.isArray(json.errors) ? json.errors.map(record) : [];
  const errors = listed.filter((error) => !input.filterError?.(error, json.data));
  if (!response.ok || errors.length) {
    const messages = errors
      .map((error) => error.message)
      .filter((message): message is string => typeof message === 'string' && !!message.trim());
    if (!messages.length && typeof json.message === 'string' && json.message)
      messages.push(json.message);
    throw new tickets.TicketSourceError(
      input.credentials(response.status, errors) ? 'credentials' : 'service',
      messages.length ? messages.join('; ') : input.fallback(response.status, response.statusText)
    );
  }
  if (!json.data || typeof json.data !== 'object') throw input.fail();
  return json.data;
}

export async function walkConnection(
  signal: AbortSignal,
  page: (after: string | undefined) => Promise<unknown>,
  fail: () => tickets.TicketSourceError,
  initial?: unknown
): Promise<unknown[]> {
  const nodes: unknown[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  // A pathological cursor stream must fail rather than silently truncate a catalog.
  for (let index = 0; index < 1_000; index++) {
    signal.throwIfAborted();
    const value = record(index === 0 && initial !== undefined ? initial : await page(after));
    const info = record(value.pageInfo);
    if (!Array.isArray(value.nodes) || typeof info.hasNextPage !== 'boolean') throw fail();
    nodes.push(...(value.nodes as unknown[]));
    if (!info.hasNextPage) return nodes;
    if (typeof info.endCursor !== 'string' || !info.endCursor || seen.has(info.endCursor))
      throw fail();
    after = info.endCursor;
    seen.add(after);
  }
  throw fail();
}

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
