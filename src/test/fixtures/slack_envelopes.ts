// PROVISIONAL — written from Slack's docs, not observed: api.slack.com/apis/socket-mode (envelopes, hello, disconnect), /events/message.im and /events/app_mention, /reference/interaction-payloads/block_actions-payload, /interactivity/slash-commands. M1 Step 3 re-takes every shape here from logged envelopes, with ids replaced.

/**
 * Socket Mode frames as Slack's docs show them, with ids replaced. Every
 * envelope is a function so a test that edits one cannot change the next.
 *
 * The cast of ids: the owner `U0OWNER01` in team `T0SQUAD01`; the bot user
 * `U0BOT0001`, bot `B0BOT0001`, app `A0APP0001`; the bot DM `D0DM00001`; a
 * channel `C0CHAN001`; a Slack Connect guest `U0GUEST01` from `T0OTHER01`.
 */

export const OWNER = 'U0OWNER01';
export const TEAM = 'T0SQUAD01';
export const BOT_USER = 'U0BOT0001';
export const BOT_ID = 'B0BOT0001';
export const DM = 'D0DM00001';
export const CHANNEL = 'C0CHAN001';
export const GUEST = 'U0GUEST01';
export const GUEST_TEAM = 'T0OTHER01';

export const P1_TS = '1760000000.000100';

export function hello(): Record<string, unknown> {
  return {
    type: 'hello',
    num_connections: 1,
    debug_info: { host: 'applink-fixture', build_number: 10, approximate_connection_time: 18060 },
    connection_info: { app_id: 'A0APP0001' }
  };
}

export function disconnect(reason: string): Record<string, unknown> {
  return { type: 'disconnect', reason, debug_info: { host: 'wss-fixture.slack.com' } };
}

/** The `events_api` envelope around one event callback. */
export function eventsApi(
  event: Record<string, unknown>,
  over: { envelopeId?: string; eventId?: string; retryAttempt?: number } = {}
): Record<string, unknown> {
  return {
    envelope_id: over.envelopeId ?? 'e1f0c3a2-0000-4000-8000-000000000001',
    payload: {
      token: 'fixture-verification-token',
      team_id: TEAM,
      api_app_id: 'A0APP0001',
      event,
      type: 'event_callback',
      event_id: over.eventId ?? 'Ev0FIXTURE01',
      event_time: 1760000001,
      authorizations: [
        { enterprise_id: null, team_id: TEAM, user_id: BOT_USER, is_bot: true, is_enterprise_install: false }
      ],
      is_ext_shared_channel: false,
      event_context: '4-fixture'
    },
    type: 'events_api',
    accepts_response_payload: false,
    retry_attempt: over.retryAttempt ?? 0,
    retry_reason: ''
  };
}

/** A person's top-level DM to the bot. */
export function dmMessage(): Record<string, unknown> {
  return {
    client_msg_id: '9f3e0000-0000-4000-8000-000000000002',
    type: 'message',
    text: 'run the tests &amp; tell me',
    user: OWNER,
    ts: '1760000005.000200',
    blocks: [],
    team: TEAM,
    channel: DM,
    event_ts: '1760000005.000200',
    channel_type: 'im'
  };
}

/** A person's reply in a DM thread under P1. */
export function dmThreadReply(): Record<string, unknown> {
  return {
    ...dmMessage(),
    text: 'hello from phone',
    ts: '1760000010.000300',
    event_ts: '1760000010.000300',
    thread_ts: P1_TS,
    parent_user_id: BOT_USER
  };
}

/** The bot's own post, echoed back on `message.im`. */
export function botEcho(): Record<string, unknown> {
  return {
    type: 'message',
    text: 'Squadron is waiting',
    user: BOT_USER,
    bot_id: BOT_ID,
    app_id: 'A0APP0001',
    bot_profile: { id: BOT_ID, name: 'Squadron', team_id: TEAM },
    ts: P1_TS,
    team: TEAM,
    channel: DM,
    event_ts: P1_TS,
    channel_type: 'im'
  };
}

/** An edit: `message_changed` carries the new message nested, and no `user`
 *  of its own. */
export function messageChanged(): Record<string, unknown> {
  return {
    type: 'message',
    subtype: 'message_changed',
    hidden: true,
    message: { type: 'message', text: 'edited', user: OWNER, ts: '1760000005.000200' },
    previous_message: { type: 'message', text: 'before', user: OWNER, ts: '1760000005.000200' },
    channel: DM,
    ts: '1760000020.000400',
    event_ts: '1760000020.000400',
    channel_type: 'im'
  };
}

/** A message with a file attached; its text is the person's words. */
export function fileShare(): Record<string, unknown> {
  return {
    type: 'message',
    subtype: 'file_share',
    text: 'see this',
    files: [{ id: 'F0FILE0001', name: 'shot.png', mimetype: 'image/png' }],
    upload: false,
    user: OWNER,
    display_as_bot: false,
    ts: '1760000030.000500',
    team: TEAM,
    channel: DM,
    event_ts: '1760000030.000500',
    channel_type: 'im'
  };
}

/** An @mention at the top level of a channel. */
export function appMention(): Record<string, unknown> {
  return {
    client_msg_id: '9f3e0000-0000-4000-8000-000000000003',
    type: 'app_mention',
    text: `<@${BOT_USER}> what is running?`,
    user: OWNER,
    ts: '1760000040.000600',
    blocks: [],
    team: TEAM,
    channel: CHANNEL,
    event_ts: '1760000040.000600'
  };
}

/** An @mention inside a channel thread, from a Slack Connect guest whose own
 *  team differs from the channel's. */
export function appMentionInThreadFromGuest(): Record<string, unknown> {
  return {
    ...appMention(),
    user: GUEST,
    user_team: GUEST_TEAM,
    source_team: GUEST_TEAM,
    ts: '1760000050.000700',
    event_ts: '1760000050.000700',
    thread_ts: '1760000040.000600'
  };
}

/** A Deny press on P5. */
export function blockActions(): Record<string, unknown> {
  return {
    envelope_id: 'e1f0c3a2-0000-4000-8000-000000000004',
    payload: {
      type: 'block_actions',
      user: { id: OWNER, username: 'owner', name: 'owner', team_id: TEAM },
      api_app_id: 'A0APP0001',
      token: 'fixture-verification-token',
      container: { type: 'message', message_ts: P1_TS, channel_id: DM, is_ephemeral: false },
      trigger_id: '1000000000.1000000000.fixture',
      team: { id: TEAM, domain: 'squad' },
      enterprise: null,
      is_enterprise_install: false,
      channel: { id: DM, name: 'directmessage' },
      message: { type: 'message', user: BOT_USER, bot_id: BOT_ID, ts: P1_TS, text: 'waiting' },
      state: { values: {} },
      response_url: 'https://hooks.slack.com/actions/T0SQUAD01/0/fixture',
      actions: [
        {
          action_id: 'sq.0',
          block_id: 'b0',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          value: 'k3x9',
          style: 'danger',
          type: 'button',
          action_ts: '1760000060.123456'
        }
      ]
    },
    type: 'interactive',
    accepts_response_payload: false
  };
}

/** `/squadron <text>` typed in the bot DM. */
export function slashCommand(text: string): Record<string, unknown> {
  return {
    envelope_id: 'e1f0c3a2-0000-4000-8000-000000000005',
    payload: {
      token: 'fixture-verification-token',
      team_id: TEAM,
      team_domain: 'squad',
      channel_id: DM,
      channel_name: 'directmessage',
      user_id: OWNER,
      user_name: 'owner',
      command: '/squadron',
      text,
      api_app_id: 'A0APP0001',
      is_enterprise_install: 'false',
      response_url: 'https://hooks.slack.com/commands/T0SQUAD01/0/fixture',
      trigger_id: '1000000000.1000000000.fixture2'
    },
    type: 'slash_commands',
    accepts_response_payload: true
  };
}
