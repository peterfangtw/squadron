import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as manifest from '../../core/slack/manifest';

describe('the Slack app manifest', () => {
  const m = manifest.slackManifest();

  it('is a plain bot: no agent or assistant view anywhere in it', () => {
    const text = JSON.stringify(m);
    assert.doesNotMatch(text, /agent_view/);
    assert.doesNotMatch(text, /assistant_view/);
  });

  it('runs over Socket Mode with a long-lived token and interactivity on', () => {
    assert.equal(m.settings.socket_mode_enabled, true);
    assert.equal(m.settings.token_rotation_enabled, false);
    assert.equal(m.settings.interactivity.is_enabled, true);
  });

  it('asks for the messaging, file, reaction and thread scopes', () => {
    assert.deepEqual([...m.oauth_config.scopes.bot].sort(), [
      'app_mentions:read',
      'channels:history',
      'chat:write',
      'commands',
      'files:read',
      'files:write',
      'groups:history',
      'im:history',
      'reactions:write',
      'users:read'
    ]);
  });

  it('subscribes to a DM and an @mention only', () => {
    assert.deepEqual([...m.settings.event_subscriptions.bot_events].sort(), [
      'app_mention',
      'message.im'
    ]);
  });

  it('has a writable Messages tab and the one slash command', () => {
    assert.equal(m.features.app_home.messages_tab_enabled, true);
    assert.equal(m.features.app_home.messages_tab_read_only_enabled, false);
    assert.deepEqual(
      m.features.slash_commands.map((c) => c.command),
      [manifest.SLASH_COMMAND]
    );
    assert.equal(manifest.SLASH_COMMAND, '/squadron');
    assert.equal(m.display_information.name, 'Squadron');
  });

  it('is fresh on every call, so a caller cannot edit the next one', () => {
    const a = manifest.slackManifest();
    a.oauth_config.scopes.bot.push('channels:history');
    assert.deepEqual(manifest.slackManifest(), m);
  });

  it('links to the create-from-manifest page with the manifest in the query', () => {
    const url = new URL(manifest.manifestUrl());
    assert.equal(url.origin, 'https://api.slack.com');
    assert.equal(url.pathname, '/apps');
    assert.equal(url.searchParams.get('new_app'), '1');
    assert.deepEqual(JSON.parse(url.searchParams.get('manifest_json') ?? ''), m);
  });
});
