/**
 * The Slack app Squadron ships: the manifest a person pastes at api.slack.com
 * to create the bot, so the app they make is the one the adapter was written
 * against.
 *
 * A plain bot over Socket Mode, which works on the Free plan. No `agent_view`
 * or `assistant_view` (D6): Slack's agent features need a paid plan, and
 * `agent_view` cannot be switched off once an app has it.
 */

/** The one slash command, matched by name on every command payload. A
 *  workspace that already has `/squadron` renames it here before creating the
 *  app. */
export const SLASH_COMMAND = '/squadron';

/** The one scope the app-level token needs, for `apps.connections.open`.
 *  Slack grants it on the token rather than in the manifest, so the manifest
 *  cannot carry it. */
export const APP_TOKEN_SCOPE = 'connections:write';
export const REACTION_SCOPE = 'reactions:write';

/** Scopes an older install may lack, by the feature they unlock. The setup
 *  check names `feature` and stays ok, saying what happens `without` it when
 *  that is not plain; the manifest still asks for each one. */
export const OPTIONAL_SCOPES: readonly {
  feature: string;
  scopes: readonly string[];
  without?: string;
}[] = [
  { feature: 'Incoming files', scopes: ['files:read'] },
  { feature: 'Message reactions', scopes: [REACTION_SCOPE] },
  { feature: 'Thread context', scopes: ['channels:history', 'groups:history'] },
  { feature: 'Author names', scopes: ['users:read'], without: 'authors show as @U…' }
];

export type SlackManifest = {
  display_information: { name: string; description: string };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: { display_name: string };
    slash_commands: {
      command: string;
      description: string;
      usage_hint: string;
      should_escape: boolean;
    }[];
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
};

/**
 * A fresh object each call, so a caller that edits one cannot change what the
 * next caller copies.
 *
 * Socket Mode needs no request URL for events, commands or interactivity.
 * Token rotation is off because a rotating bot token expires in 12 hours and
 * needs a refresh flow; the adapter holds one long-lived token.
 */
export function slackManifest(): SlackManifest {
  return {
    display_information: {
      name: 'Squadron',
      description: 'Your Squadron sessions, from wherever you are.'
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false
      },
      bot_user: { display_name: 'Squadron' },
      slash_commands: [
        {
          command: SLASH_COMMAND,
          description: 'List, start or end sessions',
          usage_hint: 'list | new <prompt> | end <pid>',
          should_escape: false
        }
      ]
    },
    oauth_config: {
      scopes: {
        bot: [
          'chat:write',
          'im:history',
          'app_mentions:read',
          'commands',
          'files:write',
          'files:read',
          REACTION_SCOPE,
          'channels:history',
          'groups:history',
          'users:read'
        ]
      }
    },
    settings: {
      event_subscriptions: { bot_events: ['message.im', 'app_mention'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false
    }
  };
}

/** The "create from manifest" link, prefilled. Slack documents
 *  `?new_app=1&manifest_json=` for sharing a manifest; Step 3 checks it still
 *  prefills. */
export function manifestUrl(): string {
  const query = new URLSearchParams({
    new_app: '1',
    manifest_json: JSON.stringify(slackManifest())
  });
  return `https://api.slack.com/apps?${query.toString()}`;
}
