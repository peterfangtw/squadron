/**
 * A Slack envelope as the bridge's `Inbound`: who sent it, in what words, and
 * where it sits. This is where the adapter drops what M0 says it drops — the
 * bot's own messages, other bots, edits, joins — and nothing else; a stranger
 * reaches the core, whose allowlist is the only one (D9).
 *
 * Only the two events the manifest subscribes to arrive, so a `message` is a
 * DM (`direct`) and an `app_mention` is a mention.
 */

import type { CommandName, Inbound } from '../bridge/model';
import * as manifest from './manifest';
import type { SocketEnvelope } from './socket';
import * as wire from './wire';

/** Edits, deletes and joins are not new messages; these two are. */
const KEPT_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

/**
 * What one envelope says to the bridge: nothing, or one event — or one per
 * action for a press, though a button press carries exactly one in practice.
 */
export function toInbound(envelope: SocketEnvelope, self: wire.Identity): readonly Inbound[] {
  switch (envelope.type) {
    case 'events_api': {
      const message = fromEvent(envelope, self);
      return message ? [message] : [];
    }
    case 'interactive':
      return fromPress(envelope);
    case 'slash_commands':
      return fromCommand(envelope);
  }
}

/**
 * A message read back from history, as the live event would have mapped. A
 * row names no team, so the bot's own workspace stands in; it is only ever a
 * DM's, read because the link was down when it arrived.
 */
export function fromHistory(event: wire.MessageEvent, self: wire.Identity): Inbound | undefined {
  return fromMessage(event, self.teamId, self);
}

function fromEvent(envelope: wire.EventsApi, self: wire.Identity): Inbound | undefined {
  return fromMessage(envelope.event, envelope.teamId, self);
}

function fromMessage(
  event: wire.SlackEvent,
  workspace: string | undefined,
  self: wire.Identity
): Inbound | undefined {
  if (event.botId !== undefined || event.user === undefined || event.user === self.userId) {
    return undefined;
  }
  if (event.type === 'message') {
    if (event.subtype !== undefined && !KEPT_SUBTYPES.has(event.subtype)) {
      return undefined;
    }
    // `message.im` says `im`. Anything else would come from a subscription
    // the manifest does not make, and is not addressed to the bot (D8). An
    // event with no channel type is read as the DM it should be.
    if (event.channelType !== undefined && event.channelType !== 'im') {
      return undefined;
    }
  }
  // A Slack Connect guest is keyed on their own team, not the channel's.
  const team = event.userTeam ?? event.team ?? workspace;
  const ref = wire.slackRef(event.channel, event.ts);
  if (team === undefined || ref === undefined) {
    return undefined;
  }
  // The parent of a thread carries its own ts as `thread_ts`; it is top-level.
  const anchor =
    event.threadTs !== undefined && event.threadTs !== event.ts
      ? wire.slackRef(event.channel, event.threadTs)
      : undefined;
  return {
    kind: 'message',
    ...(event.files
      ? {
          incoming: {
            version: 1 as const,
            installId: wire.installId(self),
            files: event.files.files.map((file) => ({
              ...file,
              source: wire.fileSource(self, file.id),
              cacheKey: wire.fileKey(self, file.id)
            })),
            omitted: event.files.omitted
          }
        }
      : {}),
    // Where it sits, not `event_id`: a redelivery and a copy read back from
    // history are one message, and so are a DM's `message` and `app_mention`.
    id: ref,
    sender: { id: `${team}:${event.user}` },
    text: plainText(event.text ?? '', self.userId),
    addressed: event.type === 'message' ? 'direct' : 'mention',
    refs: anchor === undefined ? [] : [anchor],
    ref,
    at: Math.floor(Number(event.ts) * 1000)
  };
}

/** Neither a press nor a command is retried — the person sees an error
 *  instead — so `envelope_id` is a stable enough id for both. */
function fromPress(envelope: wire.Interactive): readonly Inbound[] {
  const { payload } = envelope;
  const team = payload.userTeam ?? payload.teamId;
  const message = wire.slackRef(payload.channel, payload.messageTs);
  if (team === undefined || message === undefined) {
    return [];
  }
  return payload.actions.map((action, i) => ({
    kind: 'press',
    id: i === 0 ? envelope.envelopeId : `${envelope.envelopeId}.${i}`,
    sender: { id: `${team}:${payload.userId}` },
    payload: action.value,
    message
  }));
}

/** A slash command has no thread, so no refs; the core answers in the DM.
 *  Its text is read as typed: with `should_escape: false` (manifest.ts) Slack
 *  sends it plain, so a message's decoding would eat a prompt's `<tag>`. */
function fromCommand(envelope: wire.SlashCommand): readonly Inbound[] {
  if (envelope.command !== manifest.SLASH_COMMAND) {
    return [];
  }
  return [
    {
      kind: 'command',
      id: envelope.envelopeId,
      sender: { id: `${envelope.teamId}:${envelope.userId}` },
      ...parseCommand(envelope.text),
      refs: []
    }
  ];
}

const COMMANDS: readonly CommandName[] = ['list', 'new', 'end'];

/**
 * `list`, `new <prompt>`, `end <pid>`, by the first word in any case. Any
 * other text, or none, is `help` carrying all of it, so the core answers it
 * after its allowlist has run and in its own words.
 */
export function parseCommand(text: string): { name: CommandName; args: string } {
  const trimmed = text.trim();
  const [, word = '', rest = ''] = /^(\S*)\s*([\s\S]*)$/.exec(trimmed) ?? [];
  const name = COMMANDS.find((command) => command === word.toLowerCase());
  return name ? { name, args: rest } : { name: 'help', args: trimmed };
}

/**
 * Slack's text as the person typed it: `&amp; &lt; &gt;` unescaped, a link
 * as `label (url)` or the bare URL, a user as `@U…` or `@label`, a channel as
 * `#name`, `<!here>` as `@here`. The leading mention of `bot`, when given, is
 * removed — it is how the person addressed the bot, not what they said.
 */
export function plainText(text: string, bot?: string): string {
  const addressed =
    bot === undefined ? text : text.replace(new RegExp(`^\\s*<@${bot}(?:\\|[^>]*)?>\\s*`), '');
  return addressed.replace(/<([^<>]*)>|&(?:amp|lt|gt);/g, (match, inner?: string) =>
    inner === undefined ? unescape(match) : token(inner)
  );
}

/** One `<…>` token. Its parts are escaped like the text around them. */
function token(inner: string): string {
  const bar = inner.indexOf('|');
  const target = unescape(bar === -1 ? inner : inner.slice(0, bar));
  const label = bar === -1 ? undefined : unescape(inner.slice(bar + 1));
  switch (target[0]) {
    case '@':
      return `@${label ?? target.slice(1)}`;
    case '#':
      return `#${label ?? target.slice(1)}`;
    case '!':
      return label ?? `@${target.slice(1)}`;
    default:
      return label === undefined || label === target ? target : `${label} (${target})`;
  }
}

/** `&amp;` last, so `&amp;lt;` reads as the `&lt;` the person typed. */
function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
