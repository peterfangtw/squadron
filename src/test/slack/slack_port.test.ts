import { portContract } from '../bridge/bridge_helpers';
import { slackHarness } from './slack_helpers';

// The contract M0's fake passes, run unchanged against the Slack adapter over
// a fake Slack: envelopes in on a socket, Web API bodies read back out.
portContract('slack', slackHarness);
