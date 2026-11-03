/** Local CLI contract peer; it never connects to an MCP endpoint. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const config = JSON.parse(fs.readFileSync('mcp-fixture.json', 'utf8')) as {
  name: string; url: string; scope: string; holdLogin?: boolean;
};
const log = (value: unknown): void => fs.appendFileSync('mcp-calls.jsonl', JSON.stringify(value) + '\n');
const command = path.basename(process.argv[1] ?? '');
if (command === 'mcp') {
  log({args: process.argv.slice(2), cwd: process.cwd()});
  if (process.argv[2] === 'get') {
    console.log(`  Scope: ${config.scope[0]?.toUpperCase()}${config.scope.slice(1)} config\n  URL: ${config.url}`);
  } else if (process.argv[2] === 'list') {
    console.log(JSON.stringify([{...config, enabled: true, transport: {type: 'streamable_http', url: config.url}, auth_status: 'o_auth'}]));
  } else if (process.argv[2] === 'login' && config.holdLogin) {
    // Held until cancelled, as a login waiting on its browser is, with a held
    // detached descendant standing in for that browser; both capped so a failed
    // test cannot leak them.
    const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {detached: true, stdio: 'ignore', windowsHide: true});
    kid.unref();
    fs.writeFileSync('login-ready', `${process.pid} ${kid.pid}`);
    setTimeout(() => process.exit(124), 20_000);
  }
} else {
  const send = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
  const lines = createInterface({input: process.stdin});
  lines.on('line', line => {
    const frame = JSON.parse(line) as {id?: number; method?: string; params?: unknown};
    log({method: frame.method, params: frame.params, cwd: process.cwd(), pid: process.pid});
    const result = frame.method === 'initialize' ? {protocolVersion: 1, authMethods: [{id: 'cached_token'}], _meta: {defaultAuthMethodId: 'cached_token'}} : frame.method === 'session/new' ? {sessionId: process.cwd()} : {};
    if (frame.id !== undefined) send({jsonrpc: '2.0', id: frame.id, result});
    if (frame.method === 'session/new') send({jsonrpc: '2.0', method: '_x.ai/mcp/init_progress', params: {total: 1, connected: 1}});
  });
}
