/** The real `~/.claude.json` shape, trimmed to the keys this reads. Recorded
 *  2026-08-11 — slack carries a nested `oauth` block, linear does not. */
export const CONFIG = JSON.stringify({
  projects: {
    '/Users/x/acme-web': {
      mcpServers: {
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
        slack: {
          type: 'http',
          url: 'https://mcp.slack.com/mcp',
          oauth: { clientId: '1601185624273.8899143856786', callbackPort: 3118 }
        }
      }
    },
    '/Users/x/shop': {
      mcpServers: { sentry: { type: 'sse', url: 'https://mcp.sentry.dev/sse' } }
    },
    '/Users/x/empty': { mcpServers: {} },
    '/Users/x/nokey': { allowedTools: [] }
  }
});

import * as claude from '../../core/claude/mcp';
import * as grok from '../../core/grok/mcp';
import * as mcp from '../../core/mcp';

/** Native fixture composition for the pre-snapshot behavior controls. */
export function foldNativeMcp(opts: {
  texts: {
    claudeConfig?: string;
    grokUserConfig?: string;
    grokProjectByRoot: Readonly<Record<string, string | undefined>>;
    mcpJsonByRoot: Readonly<Record<string, string | undefined>>;
    needsAuthCache?: string;
    grokCredentials?: string;
  };
  board: mcp.McpBoard;
  health?: Map<string, claude.McpHealth>;
  canLogin?: boolean;
}): { rows: mcp.McpRow[] } {
  return (
    mcp.foldBoard({
      board: opts.board,
      snapshots: [
        claude.claudeMcpSnapshot({
          roots: opts.board.roots,
          config: opts.texts.claudeConfig,
          projectByRoot: opts.texts.mcpJsonByRoot,
          needsAuthCache: opts.texts.needsAuthCache,
          health: opts.health,
          canLogin: opts.canLogin
        }),
        grok.grokMcpSnapshot({
          roots: opts.board.roots,
          userConfig: opts.texts.grokUserConfig,
          projectByRoot: opts.texts.grokProjectByRoot,
          credentials: opts.texts.grokCredentials
        })
      ]
    }) ?? { rows: [] }
  );
}
