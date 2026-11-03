import * as incoming from '../incoming';

/**
 * Slack's shapes, narrowed at the point they arrive: the Socket Mode frames,
 * the two events the manifest subscribes to, a button press, a slash command,
 * and a Web API reply.
 *
 * Every field was written by another program, so nothing is cast. A frame is
 * built field by field out of an `unknown`; an optional field of the wrong
 * type is absent, and a missing field Slack's docs promise drops the whole
 * frame. Nothing here throws: a frame this cannot read is silence, and the
 * link stays up.
 *
 * Names are ours, not the wire's (`envelope_id` arrives, `envelopeId` leaves),
 * so this is the one file that knows Slack's spelling of an inbound field.
 *
 * Provisional (master R1): the shapes come from Slack's published docs, and
 * M1 Step 3 re-takes them from logged envelopes.
 */

export type Envelope = Hello | Disconnect | EventsApi | Interactive | SlashCommand;

/** The first frame on a new socket. `approximateConnectionTime` is seconds
 *  until Slack refreshes it. */
export type Hello = {
  type: 'hello';
  numConnections?: number;
  approximateConnectionTime?: number;
};

/** `warning` and `refresh_requested` precede a routine refresh;
 *  `link_disabled` means Socket Mode was switched off for the app. */
export type Disconnect = { type: 'disconnect'; reason?: string };

export type EventsApi = {
  type: 'events_api';
  envelopeId: string;
  /** Kept across Slack's retries of one event. A message is deduped on its
   *  `channel:ts` instead (`inbound.ts`). */
  eventId: string;
  teamId?: string;
  retryAttempt?: number;
  event: SlackEvent;
};

export type SlackEvent = MessageEvent | AppMention;

/** Fields both events carry. `team` is the workspace the message was posted
 *  in; `userTeam` is the sender's own, which differs for a Slack Connect
 *  guest. */
type EventBase = {
  channel: string;
  ts: string;
  user?: string;
  text?: string;
  threadTs?: string;
  team?: string;
  userTeam?: string;
  botId?: string;
  files?: FileDescriptors;
};

/** `message.im`, and a row of `conversations.history` or `.replies`. No `user`
 *  on an edit or a delete, which carry the message nested instead; this does
 *  not read the nested one. */
export type MessageEvent = EventBase & {
  type: 'message';
  subtype?: string;
  channelType?: string;
  /** `username` on a bot message that has no member. */
  username?: string;
  /** `bot_profile.name`. */
  botName?: string;
  /** `files[].name`. */
  fileNames?: readonly string[];
};

export type AppMention = EventBase & { type: 'app_mention'; user: string };

export type Interactive = { type: 'interactive'; envelopeId: string; payload: BlockActions };

/** A press on a button in one of the bot's messages. `userTeam` is the
 *  presser's own team, `teamId` the workspace's. */
export type BlockActions = {
  type: 'block_actions';
  userId: string;
  userTeam?: string;
  teamId?: string;
  channel: string;
  messageTs: string;
  actions: ButtonAction[];
};

export type ButtonAction = { actionId: string; value: string };

export type SlashCommand = {
  type: 'slash_commands';
  envelopeId: string;
  command: string;
  /** Everything after the command, `''` for none. */
  text: string;
  userId: string;
  teamId: string;
  channelId?: string;
};

/**
 * A narrowed frame. `envelopeId` is read on its own, before anything else, so
 * an envelope this cannot type is still acked; `envelope` is absent for a
 * frame this does not read.
 */
export type Narrowed = { envelopeId?: string; envelope?: Envelope };

export function narrowEnvelope(raw: unknown): Narrowed {
  const frame = rec(raw);
  if (!frame) {
    return {};
  }
  const envelopeId = str(frame.envelope_id);
  const envelope = readEnvelope(frame, envelopeId);
  return {
    ...(envelopeId !== undefined && { envelopeId }),
    ...(envelope && { envelope })
  };
}

/**
 * A Web API reply. `body` is the whole parsed object, for the method's own
 * reader. A reply that is not Slack's `{ ok, … }` reads as the error
 * `unreadable_reply`, a code of ours that Slack does not use.
 */
export type ApiReply =
  { ok: true; body: Readonly<Record<string, unknown>> } | { ok: false; error: string };

export function narrowReply(raw: unknown): ApiReply {
  const body = rec(raw);
  if (body?.ok === true) {
    return { ok: true, body };
  }
  const error = body?.ok === false ? str(body.error) : undefined;
  return { ok: false, error: error ?? 'unreadable_reply' };
}

/* What each method's caller reads off an ok reply's `body`, or undefined
 * when the field is missing. */

/**
 * `users.info`: the display name, else a real name. Slack sends `""` for a
 * display name nobody set, and that is not a name. `name` is the handle, not
 * a name.
 */
export function readUserInfo(body: Readonly<Record<string, unknown>>): string | undefined {
  const user = rec(body.user);
  const profile = rec(user?.profile);
  for (const value of [profile?.display_name, profile?.real_name, user?.real_name]) {
    const text = str(value);
    if (text !== undefined && text.trim() !== '') return text;
  }
  return undefined;
}

export function readAuthTest(body: Readonly<Record<string, unknown>>): NamedIdentity | undefined {
  const userId = id(body.user_id);
  const teamId = id(body.team_id);
  if (userId === undefined || teamId === undefined) {
    return undefined;
  }
  return {
    userId,
    teamId,
    ...opt('botId', str(body.bot_id)),
    ...opt('team', str(body.team)),
    ...opt('user', str(body.user))
  };
}

/** `apps.connections.open`. The URL carries a connection ticket: it is a
 *  credential, and nothing logs it. */
export function readConnectionUrl(body: Readonly<Record<string, unknown>>): string | undefined {
  const url = str(body.url);
  return url?.startsWith('wss://') ? url : undefined;
}

/** `chat.postMessage`. `channel` is where it landed, which for a post to a
 *  user id is the DM's `D…`. */
export function readPosted(
  body: Readonly<Record<string, unknown>>
): { channel: string; ts: string } | undefined {
  const channel = id(body.channel);
  const ts = tsOf(body.ts);
  return channel !== undefined && ts !== undefined ? { channel, ts } : undefined;
}

export function readPermalink(body: Readonly<Record<string, unknown>>): string | undefined {
  const url = str(body.permalink);
  return url?.startsWith('https://') ? url : undefined;
}

export function readUploadUrl(
  body: Readonly<Record<string, unknown>>
): { uploadUrl: string; fileId: string } | undefined {
  const uploadUrl = str(body.upload_url);
  const fileId = id(body.file_id);
  return uploadUrl?.startsWith('https://') && fileId !== undefined
    ? { uploadUrl, fileId }
    : undefined;
}

/**
 * Rows of `conversations.history` or `.replies` as message events. A row
 * names no channel or channel type, so the channel is the one asked; a row
 * this cannot read is left out.
 */
export function readMessages(rows: readonly unknown[], channel: string): MessageEvent[] {
  return rows.flatMap((row) => {
    const event = readEvent({ ...rec(row), channel, type: 'message' });
    return event?.type === 'message' ? [event] : [];
  });
}

/** One page of `conversations.history` or `.replies`, and the cursor to the
 *  next, absent on the last. */
export function readPage(
  body: Readonly<Record<string, unknown>>,
  channel: string
): { messages: MessageEvent[]; cursor?: string } | undefined {
  if (!Array.isArray(body.messages)) {
    return undefined;
  }
  const cursor = str(rec(body.response_metadata)?.next_cursor);
  return {
    messages: readMessages(body.messages, channel),
    ...(cursor === undefined || cursor === '' ? {} : { cursor })
  };
}

/** A member id: `U…`, or `W…` for an Enterprise Grid user. What a DM is
 *  opened on and a mention names. */
export function isMember(id: string): boolean {
  return /^[UW][A-Z0-9]+$/.test(id);
}

/** A workspace id, `T…`, or `E…` as an org-wide Grid install may report it
 *  (unobserved: accepted rather than refused on a guess). */
export function isTeam(id: string): boolean {
  return /^[TE][A-Z0-9]+$/.test(id);
}

/** The bot as `auth.test` names it. */
export type Identity = { userId: string; teamId: string; botId?: string };

/** `auth.test` as a person reads it: the workspace's and the bot's names
 *  beside the ids. */
export type NamedIdentity = Identity & { team?: string; user?: string };

/** A posted message as one opaque string, `<channel>:<ts>`. Refuses a
 *  channel or ts that would not parse back. */
export function slackRef(channel: string, ts: string): string | undefined {
  return isId(channel) && isTs(ts) ? `${channel}:${ts}` : undefined;
}

export function parseRef(ref: string): { channel: string; ts: string } | undefined {
  const parts = ref.split(':');
  const [channel, ts] = parts;
  if (parts.length !== 2 || channel === undefined || ts === undefined) {
    return undefined;
  }
  return isId(channel) && isTs(ts) ? { channel, ts } : undefined;
}

function readEnvelope(
  frame: Record<string, unknown>,
  envelopeId: string | undefined
): Envelope | undefined {
  switch (frame.type) {
    case 'hello':
      return readHello(frame);
    case 'disconnect':
      return { type: 'disconnect', ...opt('reason', str(frame.reason)) };
    case 'events_api':
      return envelopeId === undefined ? undefined : readEventsApi(frame, envelopeId);
    case 'interactive': {
      const payload = readBlockActions(rec(frame.payload));
      return envelopeId !== undefined && payload
        ? { type: 'interactive', envelopeId, payload }
        : undefined;
    }
    case 'slash_commands':
      return envelopeId === undefined ? undefined : readSlashCommand(frame, envelopeId);
    default:
      return undefined;
  }
}

function readHello(frame: Record<string, unknown>): Hello {
  return {
    type: 'hello',
    ...opt('numConnections', num(frame.num_connections)),
    ...opt('approximateConnectionTime', num(rec(frame.debug_info)?.approximate_connection_time))
  };
}

function readEventsApi(frame: Record<string, unknown>, envelopeId: string): EventsApi | undefined {
  const payload = rec(frame.payload);
  const eventId = str(payload?.event_id);
  const event = readEvent(rec(payload?.event));
  if (!payload || eventId === undefined || !event) {
    return undefined;
  }
  return {
    type: 'events_api',
    envelopeId,
    eventId,
    ...opt('teamId', id(payload.team_id)),
    ...opt('retryAttempt', num(frame.retry_attempt)),
    event
  };
}

function readEvent(event: Record<string, unknown> | undefined): SlackEvent | undefined {
  const channel = id(event?.channel);
  const ts = tsOf(event?.ts);
  if (!event || channel === undefined || ts === undefined) {
    return undefined;
  }
  const base = {
    channel,
    ts,
    ...opt('user', id(event.user)),
    ...opt('text', str(event.text)),
    ...opt('threadTs', tsOf(event.thread_ts)),
    ...opt('team', id(event.team)),
    ...opt('userTeam', id(event.user_team)),
    ...opt('botId', str(event.bot_id)),
    ...opt('files', readFiles(event.files))
  };
  if (event.type === 'message') {
    return {
      type: 'message',
      ...base,
      ...opt('subtype', str(event.subtype)),
      ...opt('channelType', str(event.channel_type)),
      ...opt('username', str(event.username)),
      ...opt('botName', str(rec(event.bot_profile)?.name)),
      ...opt('fileNames', namesOf(event.files))
    };
  }
  if (event.type === 'app_mention' && base.user !== undefined) {
    return { type: 'app_mention', ...base, user: base.user };
  }
  return undefined;
}

function readBlockActions(payload: Record<string, unknown> | undefined): BlockActions | undefined {
  const user = rec(payload?.user);
  const userId = id(user?.id);
  const container = rec(payload?.container);
  const channel = id(container?.channel_id);
  const messageTs = tsOf(container?.message_ts);
  if (
    payload?.type !== 'block_actions' ||
    userId === undefined ||
    channel === undefined ||
    messageTs === undefined
  ) {
    return undefined;
  }
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  return {
    type: 'block_actions',
    userId,
    ...opt('userTeam', id(user?.team_id)),
    ...opt('teamId', id(rec(payload.team)?.id)),
    channel,
    messageTs,
    actions: actions.flatMap((entry) => {
      const action = rec(entry);
      const actionId = str(action?.action_id);
      const value = str(action?.value);
      return actionId !== undefined && value !== undefined ? [{ actionId, value }] : [];
    })
  };
}

function readSlashCommand(
  frame: Record<string, unknown>,
  envelopeId: string
): SlashCommand | undefined {
  const payload = rec(frame.payload);
  const command = str(payload?.command);
  const text = str(payload?.text);
  const userId = id(payload?.user_id);
  const teamId = id(payload?.team_id);
  if (command === undefined || text === undefined || userId === undefined || teamId === undefined) {
    return undefined;
  }
  return {
    type: 'slash_commands',
    envelopeId,
    command,
    text,
    userId,
    teamId,
    ...opt('channelId', id(payload?.channel_id))
  };
}

/** A key only when its value is present, so a shape carries no `undefined`
 *  members for a deep equality or a spread to trip on. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A team, user, channel or bot-user id: `T…`, `U…`, `W…`, `C…`, `D…`,
 *  `G…`. Upper-case letters and digits, which is also what keeps `:` out of
 *  a ref. */
function isId(value: string): boolean {
  return /^[A-Z0-9]+$/.test(value);
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && isId(value) ? value : undefined;
}

/** A message timestamp, `1700000000.000100`: Slack's id for a message within
 *  its channel. */
function isTs(value: string): boolean {
  return /^\d+\.\d+$/.test(value);
}

function tsOf(value: unknown): string | undefined {
  return typeof value === 'string' && isTs(value) ? value : undefined;
}

/** An entry with no string name is left out. Not a list leaves the field off. */
function namesOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((entry) => {
    const name = str(rec(entry)?.name);
    return name === undefined ? [] : [name];
  });
  return names.length === 0 ? undefined : names;
}

export type FileDescriptor = { id: string; name?: string; mime?: string; size?: number };
export type FileDescriptors = { files: readonly FileDescriptor[]; omitted: number };
export type FileInfo = FileDescriptor & { mode?: string; external?: boolean; downloadUrl?: string };

export function installId(self: Identity): string {
  return `slack:${self.teamId}:${self.userId}`;
}

export function fileSource(self: Identity, fileId: string): string {
  return `${installId(self)}:${fileId}`;
}

export function fileKey(self: Identity, fileId: string): string {
  return `slack_${self.teamId}_${self.userId}_${fileId}`;
}

export function readFileInfo(body: Readonly<Record<string, unknown>>): FileInfo | undefined {
  const raw = rec(body.file);
  const file = readFile(raw);
  if (!raw || !file) return undefined;
  return {
    ...file,
    ...opt('mode', str(raw.mode)),
    ...opt('external', typeof raw.is_external === 'boolean' ? raw.is_external : undefined),
    ...opt('downloadUrl', str(raw.url_private_download) ?? str(raw.url_private))
  };
}

function readFiles(raw: unknown): FileDescriptors | undefined {
  if (!Array.isArray(raw)) return undefined;
  const files: FileDescriptor[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  for (const item of raw as unknown[]) {
    const file = readFile(rec(item));
    if (!file || seen.has(file.id)) continue;
    seen.add(file.id);
    if (files.length < incoming.INCOMING_MAX_FILES) files.push(file);
    else omitted++;
  }
  return files.length || omitted ? { files, omitted } : undefined;
}

function readFile(raw: Record<string, unknown> | undefined): FileDescriptor | undefined {
  if (!raw || typeof raw.id !== 'string' || !/^F[A-Z0-9]{1,127}$/.test(raw.id)) return undefined;
  return {
    id: raw.id,
    ...(incoming.incomingString(raw.name, 512) ? { name: raw.name } : {}),
    ...(incoming.incomingString(raw.mimetype, 128) ? { mime: raw.mimetype } : {}),
    ...(typeof raw.size === 'number' && Number.isSafeInteger(raw.size) && raw.size >= 0
      ? { size: raw.size }
      : {})
  };
}
