/** Codex app-server items in the product's completed transcript shape. */

import type { Session } from '../model';
import { NO_WITNESS, type RecordLine, type Witness } from '../record';
import { scrubbedInput } from '../scrub';
import { delivered } from '../coordination/send';
import { proseImages } from '../prose_images';
import {
  cutOutput as cut,
  MAX_TURNS,
  type AnsweredAsk,
  type Authored,
  type Exchange,
  type Marker,
  type Recent,
  type ToolCall
} from '../transcript';
import { CodexFailure } from './client';
import { connectCodex, type CodexPathConnector } from './runtime';

/** A thread read, plus every item id the read saw, in order too. */
type TranscriptRead = {
  recent: Recent;
  witnessed: ReadonlySet<string>;
  order: readonly Witness[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cutOutput(value: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof value === 'string') {
    raw = value;
  } else if (value !== undefined && value !== null) {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = undefined;
    }
  }
  return raw === undefined ? undefined : cut(raw);
}

type Witnessed = RecordLine & { m: string };

function witnessed(line: RecordLine, id: string): Witnessed {
  return { ...line, m: id };
}

/**
 * A user item as the turns it holds: one per text item, each read on its own
 * words, since a merged delivery is one item of several blocks and each block is
 * one message (0.160.0 keeps them apart, probed 2026-10-04). A picture goes on
 * the words before it, or on a turn of its own when nothing precedes it.
 *
 * A typed `{ type: 'skill' }` part is the client invoking that skill, and is a
 * marker after the item's turns. Only the typed part: Codex also expands a
 * `$name` in text, but the item it echoes keeps that as plain text and the
 * expansion is in the rollout alone (0.164.0, `cli_state/codex/protocol.md`).
 *
 * Only for an item we hold no row for — the stored-thread reader, and an echo
 * whose send we did not make. A row we sent is recorded off itself in `tee.ts`.
 */
function userLines(
  item: Record<string, unknown>,
  id: string,
  at: number | undefined
): RecordLine[] {
  const content = Array.isArray(item.content) ? item.content : [];
  const said: { raw: string; images: ImageRef[] }[] = [];
  const skills: Marker[] = [];
  let pictures = 0;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      said.push({ raw: part.text, images: [] });
      continue;
    }
    if (part.type === 'skill') {
      const name = text(part.name);
      if (name) skills.push({ mark: 'skill', skill: name, by: 'you' });
      continue;
    }
    if (part.type !== 'localImage' || typeof part.path !== 'string') continue;
    const ref = { id: `f|${id}|0.${pictures}|${part.path}` };
    pictures++;
    const before = said[said.length - 1];
    if (before) before.images.push(ref);
    else said.push({ raw: '', images: [ref] });
  }
  const turns = said.flatMap(({ raw, images }): Authored[] => {
    const { role, text: words, from } = delivered(raw);
    const text = words.trim();
    if (!text && !images.length) return [];
    return [
      {
        role,
        text,
        ...(text ? { blocks: [{ text }] } : {}),
        ...(at === undefined ? {} : { at }),
        ...(images.length ? { images } : {}),
        ...(from === undefined ? {} : { from })
      }
    ];
  });
  // An item with nothing in it is still the prompt that ordinal names.
  const [first, ...rest] = turns.length
    ? turns
    : [{ role: 'user' as const, text: '', ...(at === undefined ? {} : { at }) }];
  return first ? [witnessed(first, id), ...rest, ...skills] : [];
}

function agentLine(
  item: Record<string, unknown>,
  id: string,
  at: number | undefined,
  cwd: string
): RecordLine {
  const raw = typeof item.text === 'string' ? item.text : '';
  const { prose, refs } = proseImages(raw, id, 0, cwd);
  if (!raw && !refs.length) return { m: id };
  return witnessed(
    {
      role: 'assistant',
      text: raw,
      ...(prose.trim() ? { blocks: [{ text: prose }] } : {}),
      ...(at === undefined ? {} : { at }),
      ...(refs.length ? { images: refs } : {})
    },
    id
  );
}

function callLine(
  id: string,
  call: ToolCall,
  at: number | undefined,
  extra: Partial<Authored> = {}
): RecordLine {
  return witnessed(
    {
      role: 'assistant',
      text: '',
      blocks: [{ call }],
      ...(at === undefined ? {} : { at }),
      ...extra
    },
    id
  );
}

/**
 * An answered `requestUserInput` as a call of its own, keyed by the request's
 * `itemId`. App-server raises a question as a server request and completes no
 * item for it — the 0.151.0 `question` fixture names `<item-19>` on the request
 * and nowhere else — so the answer has no call to be folded onto otherwise.
 * `request_user_input` is the tool's name in the rollout.
 */
export function askLine(itemId: string, ask: AnsweredAsk, at: number): RecordLine {
  return callLine(itemId, { id: itemId, name: 'request_user_input', ask }, at);
}

// A tool item stops carrying output once it settles, so an absent output at
// these three statuses is empty rather than pending.
function settled(status: unknown): boolean {
  return status === 'completed' || status === 'failed' || status === 'declined';
}

function commandLine(item: Record<string, unknown>, id: string, at?: number): RecordLine {
  const input = scrubbedInput({ command: item.command, cwd: item.cwd });
  const call: ToolCall = { id, name: 'Bash' };
  if (input) call.input = input;
  const output = cutOutput(item.aggregatedOutput);
  if (output !== undefined) call.output = output;
  else if (settled(item.status)) call.output = '';
  if (
    item.status === 'failed' ||
    item.status === 'declined' ||
    (finite(item.exitCode) && item.exitCode !== 0)
  ) {
    call.failed = true;
  }
  return callLine(id, call, at);
}

function diffSize(diff: unknown, kind: unknown): { add: number; del: number } | undefined {
  if (typeof diff !== 'string') return undefined;
  const changed = diff.endsWith('\n') ? diff.slice(0, -1) : diff;
  const lines = changed ? changed.split('\n').length : 0;
  const type = isRecord(kind) ? kind.type : undefined;
  if (type === 'add') return { add: lines, del: 0 };
  if (type === 'delete') return { add: 0, del: lines };
  let add = 0;
  let del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return add || del ? { add, del } : undefined;
}

function fileLine(item: Record<string, unknown>, id: string, at?: number): RecordLine {
  const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
  // A declined patch completes with its whole `changes` list still attached
  // (`denied.json`, 0.151.0; seen again live on 0.153.2, 2026-09-05), and the
  // file it names was never written. The call keeps the diff for the reader;
  // `files` and `sizes` are what a write pill is drawn from, so a declined item
  // states neither. A `failed` one still draws its pill: whether a failed
  // apply_patch wrote anything has not been observed.
  const declined = item.status === 'declined';
  const failed = declined || item.status === 'failed';
  const files: string[] = [];
  const sizes: Record<string, { add: number; del: number }> = {};
  const calls = changes.flatMap((change, index): ToolCall[] => {
    if (typeof change.path !== 'string' || !change.path) return [];
    if (!declined) {
      if (!files.includes(change.path)) files.push(change.path);
      const size = diffSize(change.diff, change.kind);
      if (size) sizes[change.path] = size;
    }
    const input = scrubbedInput({ file_path: change.path, diff: change.diff });
    return [
      {
        id: changes.length === 1 ? id : `${id}:${index}`,
        name: 'Edit',
        ...(input ? { input } : {}),
        ...(settled(item.status) ? { output: '' } : {}),
        ...(failed ? { failed: true as const } : {})
      }
    ];
  });
  const fallback: ToolCall = {
    id,
    name: 'Edit',
    ...(failed ? { failed: true as const } : {})
  };
  return witnessed(
    {
      role: 'assistant',
      text: '',
      blocks: (calls.length ? calls : [fallback]).map((call) => ({ call })),
      ...(at === undefined ? {} : { at }),
      ...(files.length ? { files } : {}),
      ...(Object.keys(sizes).length ? { sizes } : {})
    },
    id
  );
}

function mcpOutput(item: Record<string, unknown>): unknown {
  if (isRecord(item.error) && typeof item.error.message === 'string') return item.error.message;
  const result = isRecord(item.result) ? item.result : undefined;
  return result?.structuredContent ?? result?.content;
}

function genericCall(item: Record<string, unknown>, id: string, at?: number): RecordLine {
  const type = typeof item.type === 'string' ? item.type : 'a tool';
  let name = typeof item.tool === 'string' && item.tool ? item.tool : type;
  if (type === 'mcpToolCall' && typeof item.server === 'string') name = `${item.server}.${name}`;
  const rawInput =
    item.arguments ?? (type === 'functionCallOutput' ? { namespace: item.namespace } : {});
  const input = scrubbedInput(rawInput);
  const output = cutOutput(
    type === 'dynamicToolCall'
      ? item.contentItems
      : type === 'functionCallOutput'
        ? item.output
        : mcpOutput(item)
  );
  const call: ToolCall = { id, name };
  if (input) call.input = input;
  if (output !== undefined) call.output = output;
  else if (settled(item.status) || typeof item.success === 'boolean') {
    call.output = '';
  }
  if (
    item.status === 'failed' ||
    item.status === 'declined' ||
    item.success === false ||
    item.error
  ) {
    call.failed = true;
  }
  return callLine(id, call, at);
}

/**
 * One completed app-server item as record lines. Deltas never enter here: the
 * completed item is the replacement copy and therefore the only disk line.
 */
export function linesForItem(value: unknown, at: number | undefined, cwd: string): RecordLine[] {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return [];
  const id = value.id;
  switch (value.type) {
    case 'userMessage':
      return userLines(value, id, at);
    case 'agentMessage':
      return [agentLine(value, id, at, cwd)];
    case 'plan': {
      const prose = typeof value.text === 'string' ? value.text : '';
      if (!prose) return [{ m: id }];
      return [
        witnessed(
          {
            role: 'assistant',
            text: prose,
            ...(prose ? { blocks: [{ text: prose }] } : {}),
            ...(at === undefined ? {} : { at })
          },
          id
        )
      ];
    }
    case 'commandExecution':
      return [commandLine(value, id, at)];
    case 'fileChange':
      return [fileLine(value, id, at)];
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'functionCallOutput':
    case 'webSearch':
    case 'collabAgentToolCall':
    case 'subAgentActivity':
    case 'sleep':
    case 'imageGeneration':
      return [genericCall(value, id, at)];
    case 'imageView': {
      const refs = typeof value.path === 'string' ? [{ id: `f|${id}|0.0|${value.path}` }] : [];
      if (!refs.length) return [{ m: id }];
      return [
        witnessed(
          {
            role: 'assistant',
            text: '',
            ...(at === undefined ? {} : { at }),
            ...(refs.length ? { images: refs } : {})
          },
          id
        )
      ];
    }
    // Reasoning has a live thought surface but no completed transcript block.
    // The bare witness still proves our record saw the item.
    default:
      return [{ m: id }];
  }
}

export function linesForTurnEnd(turn: unknown, at?: number): RecordLine[] {
  if (!isRecord(turn)) return [];
  if (turn.status === 'interrupted') return [{ mark: 'break' }];
  if (turn.status !== 'failed' && turn.status !== 'error') return [];
  const error = isRecord(turn.error) ? turn.error : undefined;
  const message = text(error?.message) ?? text(error?.additionalDetails) ?? 'Codex turn failed.';
  return [
    { role: 'cli', text: message, blocks: [{ text: message }], ...(at === undefined ? {} : { at }) }
  ];
}

type TurnPage = {
  id: string;
  status?: unknown;
  error?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
};
type ItemEntry = { turnId: string; item: unknown };

/** Rebuild one complete thread from ordered turn rows and ordered item rows. */
export function transcriptFromPages(
  turns: readonly TurnPage[],
  entries: readonly ItemEntry[],
  cwd: string
): TranscriptRead {
  const byTurn = new Map<string, unknown[]>();
  for (const entry of entries) {
    if (!entry.turnId) continue;
    const items = byTurn.get(entry.turnId) ?? [];
    items.push(entry.item);
    byTurn.set(entry.turnId, items);
  }
  const exchanges: Exchange[] = [];
  const seen = new Set<string>();
  // An item's exchange opens at its own first row.
  const order: Witness[] = [];
  let sawWarm = false;
  for (const turn of turns) {
    const from = exchanges.length;
    const at = finite(turn.startedAt);
    for (const item of byTurn.get(turn.id) ?? []) {
      if (isRecord(item) && typeof item.id === 'string' && item.id && !seen.has(item.id)) {
        seen.add(item.id);
        order.push({ key: item.id, from: exchanges.length });
      }
      for (const line of linesForItem(item, at === undefined ? undefined : at * 1000, cwd)) {
        if ('role' in line || 'mark' in line) {
          const { m: _witness, ...exchange } = line as RecordLine & { m?: string };
          void _witness;
          exchanges.push(exchange as Exchange);
        }
      }
    }
    const completedAt = finite(turn.completedAt);
    exchanges.push(
      ...(linesForTurnEnd(
        turn,
        completedAt === undefined ? undefined : completedAt * 1000
      ) as Exchange[])
    );
    const owned = exchanges.slice(from).some((x) => 'role' in x && x.role === 'warm');
    sawWarm ||= owned;
    if (sawWarm) {
      for (let i = from; i < exchanges.length; i++) {
        const x = exchanges[i];
        if (x && 'role' in x && (x.role === 'assistant' || x.role === 'cli'))
          exchanges[i] = { ...x, maintenance: owned };
      }
    }
  }

  let authored = 0;
  let from = 0;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const one = exchanges[i];
    if (one && !('mark' in one)) authored++;
    if (authored > MAX_TURNS) {
      from = i + 1;
      break;
    }
  }
  return {
    recent: { exchanges: exchanges.slice(from), truncated: from > 0 },
    witnessed: seen,
    order: order.map((one) => ({ key: one.key, from: one.from - from }))
  };
}

export interface CodexRequester {
  request(method: string, params?: unknown): Promise<unknown>;
}

function page(value: unknown, method: string): { data: unknown[]; nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error(`Codex returned a malformed ${method} response`);
  }
  const next = value.nextCursor;
  if (next !== null && next !== undefined && typeof next !== 'string') {
    throw new Error(`Codex returned a malformed ${method} cursor`);
  }
  return { data: value.data, nextCursor: typeof next === 'string' ? next : null };
}

async function allPages(
  client: CodexRequester,
  method: string,
  base: Record<string, unknown>
): Promise<unknown[]> {
  const out: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = page(
      await client.request(method, { ...base, ...(cursor ? { cursor } : {}) }),
      method
    );
    out.push(...result.data);
    cursor = result.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error(`Codex repeated a ${method} cursor`);
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return out;
}

const emptyRead = (): TranscriptRead => ({
  recent: { exchanges: [], truncated: false },
  witnessed: NO_WITNESS,
  order: []
});

/**
 * A `thread/turns/list` refusal that means "no transcript yet" rather than "the
 * read failed" — the two spellings 0.151.0 has for a thread with no first user
 * message, under *An empty thread refuses both paginated reads* in
 * `reference/cli_state/codex/transcript.md`.
 *
 * Matched on the code alone, not on either sentence, because Codex has two
 * wordings for the one condition. That does mean a malformed-params bug in the
 * call below would read as an empty thread instead of throwing, so the params
 * are asserted whole in `codex_transcript.test.ts` rather than left to this.
 */
function unmaterialized(error: unknown): boolean {
  return error instanceof CodexFailure && error.code === -32600;
}

/** Read every turn and item through the supported paginated methods. */
export async function readPaginated(
  client: CodexRequester,
  session: Pick<Session, 'sessionId' | 'cwd'>
): Promise<TranscriptRead> {
  let turnsRaw: unknown[];
  try {
    turnsRaw = await allPages(client, 'thread/turns/list', {
      threadId: session.sessionId,
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'notLoaded'
    });
  } catch (error) {
    if (!unmaterialized(error)) throw error;
    return emptyRead();
  }
  const itemsRaw = await allPages(client, 'thread/items/list', {
    threadId: session.sessionId,
    limit: 100,
    sortDirection: 'asc'
  });
  const turns: TurnPage[] = turnsRaw.flatMap((value) =>
    isRecord(value) && typeof value.id === 'string'
      ? [
          {
            id: value.id,
            status: value.status,
            error: value.error,
            startedAt: value.startedAt,
            completedAt: value.completedAt
          }
        ]
      : []
  );
  const entries: ItemEntry[] = itemsRaw.flatMap((value) =>
    isRecord(value) && typeof value.turnId === 'string' && Object.hasOwn(value, 'item')
      ? [{ turnId: value.turnId, item: value.item }]
      : []
  );
  const fingerprint = JSON.stringify([turnsRaw, itemsRaw, session.cwd]);
  const key = session.sessionId;
  const hit = paginatedCache.get(key);
  if (hit?.fingerprint === fingerprint) return hit.read;
  const read = transcriptFromPages(turns, entries, session.cwd);
  keepNewest(paginatedCache, key, { fingerprint, read }, PAGINATED_MAX);
  return read;
}

/**
 * Re-insert at the newest end and evict from the oldest, so a host that never
 * restarts bounds both caches below. Map iteration is insertion order, which
 * is why the delete before the set is the whole of the "recently used" part.
 */
function keepNewest<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

const PAGINATED_MAX = 64;
const paginatedCache = new Map<
  string,
  {
    fingerprint: string;
    read: TranscriptRead;
  }
>();

const FALLBACK_MS = 15_000;
const FALLBACK_MAX = 64;
const fallback = new Map<
  string,
  { at: number; read: TranscriptRead; pending?: Promise<TranscriptRead> }
>();

/**
 * A read-only stored-thread fallback, coalesced across panel polls.
 *
 * `clock` is read twice on purpose: once to age the held entry, once when the
 * read lands. Stamping the call-time reading would charge a slow connect
 * against the 15s window and re-spawn an app-server on the next 3s paint.
 */
export async function readStoredTranscript(
  session: Pick<Session, 'sessionId' | 'cwd'>,
  override?: string,
  connector: CodexPathConnector = (path) => connectCodex(path, 10_000),
  clock: () => number = Date.now
): Promise<TranscriptRead> {
  if (!session.sessionId) return emptyRead();
  const key = `${override ?? ''}\0${session.sessionId}\0${session.cwd}`;
  const held = fallback.get(key);
  if (held?.pending) return held.pending;
  if (held && clock() - held.at < FALLBACK_MS) return held.read;
  const pending = (async (): Promise<TranscriptRead> => {
    try {
      const opened = await connector(override);
      if (!opened.ok) return held?.read ?? emptyRead();
      // C4 measured both methods on an initialized client with no resume. A
      // fallback is a reader, not a contender for the thread's writer lock.
      try {
        return await readPaginated(opened.connection.client, session);
      } finally {
        opened.connection.close();
      }
    } catch {
      return held?.read ?? emptyRead();
    }
  })();
  fallback.set(key, { at: held?.at ?? 0, read: held?.read ?? emptyRead(), pending });
  const read = await pending;
  keepNewest(fallback, key, { at: clock(), read }, FALLBACK_MAX);
  return read;
}

export function resetCodexFallbackForTest(): void {
  fallback.clear();
}

type ActiveReader = () => Promise<TranscriptRead>;
const active = new Map<string, ActiveReader>();

export function registerTranscriptReader(threadId: string, reader: ActiveReader): () => void {
  let pending: ReturnType<ActiveReader> | undefined;
  const joined: ActiveReader = () => {
    pending ??= reader().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  active.set(threadId, joined);
  return () => {
    if (active.get(threadId) === joined) active.delete(threadId);
  };
}

export function activeTranscriptReader(threadId: string): ActiveReader | undefined {
  return active.get(threadId);
}
