import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type * as tickets from '../../core/tickets';
import * as connections from '../../core/tickets/connections';
import * as github from '../../core/tickets/github';
import * as linear from '../../core/tickets/linear';
import * as ticketDisconnect from '../../ui/ticket_disconnect';

const context = (settings: Record<string, string> = {}): tickets.OpenContext => ({
  endpoint: 'http://127.0.0.1:9000/graphql',
  generation: 4,
  setting: (key) => settings[key]
});

describe('ticket connections', () => {
  it('offers Linear, then GitHub Projects', () => {
    assert.deepEqual(
      connections.CONNECTORS.map((entry) => entry.offer.sourceId),
      [linear.SOURCE_ID, github.SOURCE_ID]
    );
    assert.equal(connections.connector(github.SOURCE_ID), github.CONNECTOR);
    assert.equal(connections.connector('jira'), undefined);
  });

  it('keeps each source in its own keychain record', () => {
    const keys = connections.CONNECTORS.map((entry) => entry.secretKey);
    assert.equal(new Set(keys).size, keys.length);
  });

  // The keychain outlives a build: a record an older build stored must still open.
  it('reads the records earlier builds stored', () => {
    assert.deepEqual(linear.CONNECTOR.decode('lin_api_abc'), { apiKey: 'lin_api_abc' });
    assert.deepEqual(github.CONNECTOR.decode('{"owner":"acme","token":"ghp_x"}'), {
      owner: 'acme',
      token: 'ghp_x'
    });
  });

  it('round-trips each record', () => {
    const key = { apiKey: 'lin_api_abc' };
    assert.deepEqual(linear.CONNECTOR.decode(linear.CONNECTOR.encode(key)), key);
    const pair = { owner: 'acme', token: 'ghp_x' };
    assert.deepEqual(github.CONNECTOR.decode(github.CONNECTOR.encode(pair)), pair);
  });

  it('reads a missing or malformed record as disconnected', () => {
    for (const raw of [undefined, '']) {
      assert.equal(linear.CONNECTOR.decode(raw), undefined);
      assert.equal(github.CONNECTOR.decode(raw), undefined);
    }
    for (const raw of ['{', 'null', '[]', '"ghp_x"', '{"owner":"acme"}', '{"owner":1,"token":"t"}'])
      assert.equal(github.CONNECTOR.decode(raw), undefined, raw);
    assert.equal(connections.openConnection(github.CONNECTOR, '{', context()), undefined);
  });

  it('opens Linear with the legacy team setting, and GitHub without one', () => {
    const lin = connections.openConnection(
      linear.CONNECTOR,
      'lin_api_abc',
      context({ 'linear.team': 'ENG' })
    );
    assert.equal(lin?.sourceId, linear.SOURCE_ID);
    assert.equal(lin?.generation, 4);
    assert.equal(lin?.legacyTeamKey, 'ENG');
    assert.equal(lin?.presentation, linear.PRESENTATION);
    assert.ok(lin?.source instanceof linear.LinearSource);
    assert.equal(
      connections.openConnection(linear.CONNECTOR, 'lin_api_abc', context({ 'linear.team': '' }))
        ?.legacyTeamKey,
      undefined
    );

    const gh = connections.openConnection(
      github.CONNECTOR,
      '{"owner":"acme","token":"ghp_x"}',
      context({ 'linear.team': 'ENG' })
    );
    assert.equal(gh?.sourceId, github.SOURCE_ID);
    assert.equal(gh?.legacyTeamKey, undefined);
    assert.ok(gh?.source instanceof github.GithubSource);
  });

  it('takes only the user scope for an endpoint', () => {
    const evil = 'https://evil.example/graphql';
    assert.equal(github.CONNECTOR.endpoint({ workspaceValue: evil }), github.ENDPOINT);
    assert.equal(
      github.CONNECTOR.endpoint({ globalValue: ' http://127.0.0.1:1/g ' }),
      'http://127.0.0.1:1/g'
    );
    assert.equal(linear.CONNECTOR.endpoint({ workspaceFolderValue: evil }), linear.LINEAR_ENDPOINT);
  });
});

describe('GitHub connect validators', () => {
  it('accepts a login and refuses anything else', () => {
    for (const login of ['acme', ' acme-web ', 'a', 'A1-b2'])
      assert.equal(github.ownerProblem(login), undefined, login);
    for (const bad of ['', '-acme', 'acme/web', 'acme_web', 'a'.repeat(40)])
      assert.equal(github.ownerProblem(bad), 'Enter an organization or user login.', bad);
  });

  it('refuses a fine-grained or empty token', () => {
    assert.equal(github.tokenProblem('ghp_abc'), undefined);
    assert.equal(
      github.tokenProblem(' github_pat_abc'),
      'Use a personal access token (classic), not a fine-grained token.'
    );
    assert.equal(github.tokenProblem('   '), 'Enter your classic token.');
  });
});

describe('ticket disconnect confirmation', () => {
  it('names the source and offers one destructive action', () => {
    for (const entry of connections.CONNECTORS) {
      const view = ticketDisconnect.disconnectConfirmation(entry);
      assert.match(view.title, new RegExp(entry.offer.label));
      assert.match(view.detail, new RegExp(entry.offer.label));
      const destructive = view.actions.filter((action) => action.destructive);
      assert.deepEqual(
        destructive.map((action) => action.id),
        [ticketDisconnect.DISCONNECT_ACTION]
      );
    }
  });
});
