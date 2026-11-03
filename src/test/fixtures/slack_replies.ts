// PROVISIONAL — written from Slack's docs, not observed: api.slack.com/methods/auth.test, /methods/apps.connections.open, /methods/chat.postMessage, /methods/chat.update, /methods/chat.getPermalink, /methods/files.getUploadURLExternal, /methods/files.completeUploadExternal, and /apis/rate-limits for the 429. M1 Step 3 re-takes every shape here from logged replies, with ids replaced.

/**
 * Web API replies as Slack's docs show them, with ids replaced. Each is a
 * function so a test that edits one cannot change the next. Ids match
 * `slack_envelopes.ts`.
 */

export function authTest(): Record<string, unknown> {
  return {
    ok: true,
    url: 'https://squad.slack.com/',
    team: 'Squad',
    user: 'squadron',
    team_id: 'T0SQUAD01',
    user_id: 'U0BOT0001',
    bot_id: 'B0BOT0001',
    is_enterprise_install: false
  };
}

export function connectionsOpen(): Record<string, unknown> {
  return { ok: true, url: 'wss://wss-primary.slack.com/link/?ticket=fixture-ticket&app_id=A0APP0001' };
}

export function postMessage(channel: string, ts: string): Record<string, unknown> {
  return {
    ok: true,
    channel,
    ts,
    message: { type: 'message', user: 'U0BOT0001', bot_id: 'B0BOT0001', text: 'posted', ts }
  };
}

export function update(channel: string, ts: string): Record<string, unknown> {
  return { ok: true, channel, ts, text: 'settled', message: { text: 'settled' } };
}

export function permalink(channel: string): Record<string, unknown> {
  return {
    ok: true,
    channel,
    permalink: 'https://squad.slack.com/archives/D0DM00001/p1760000000000100'
  };
}

export function uploadUrl(): Record<string, unknown> {
  return {
    ok: true,
    upload_url: 'https://files.slack.com/upload/v1/fixture-upload',
    file_id: 'F0FILE0002'
  };
}

export function completeUpload(): Record<string, unknown> {
  return { ok: true, files: [{ id: 'F0FILE0002', title: 'shot.png' }] };
}

export function error(code: string): Record<string, unknown> {
  return { ok: false, error: code };
}

/** What a 429 carries: the status, a `Retry-After` in seconds, and Slack's
 *  error body. */
export function rateLimited(): Record<string, unknown> {
  return { ok: false, error: 'ratelimited' };
}

/** `conversations.history` or `.replies`: one page of messages, newest first
 *  for history, and the cursor to the next page, `''` on the last. */
export function messages(
  rows: readonly Record<string, unknown>[],
  cursor = ''
): Record<string, unknown> {
  return {
    ok: true,
    messages: rows,
    has_more: cursor !== '',
    response_metadata: { next_cursor: cursor }
  };
}
