import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionCall } from '../checkpoint';
import type { ExecutionIntegration } from '../execution';
import * as platform from '../platform';
import * as commands from '../platform/commands';
import type { CodexClient } from './client';

export async function diagnose(
  client: CodexClient,
  cwd: string,
  log?: (line: string) => void,
  contextFile?: string
): Promise<void> {
  try {
    const value = await client.request('hooks/list', { cwds: [cwd] });
    const result = value as {
      data?: { hooks?: { source?: unknown; enabled?: unknown; trustStatus?: unknown }[] }[];
    } | null;
    const hooks =
      result?.data
        ?.flatMap((entry) => entry.hooks ?? [])
        .filter((hook) => hook.source === 'sessionFlags') ?? [];
    if (!hooks.length) log?.('Execution hooks unavailable; retaining turn captures.');
    else if (
      hooks.some(
        (hook) => !hook.enabled || !['trusted', 'managed'].includes(String(hook.trustStatus))
      )
    ) {
      const review = contextFile
        ? path.join(path.dirname(contextFile), 'codex-hook-review.txt')
        : undefined;
      log?.(
        `Execution hooks need Codex native /hooks review for the scoped session-flags source; retaining turn captures until hooks run.${review ? ` Review command: ${review}` : ''}`
      );
    }
  } catch {
    log?.(
      'Execution hook diagnostics unavailable; retaining turn captures unless actual captures prove coverage.'
    );
  }
}

export function eligibility(type: string): ExecutionCall['eligibility'] {
  if (['commandExecution', 'fileChange'].includes(type)) return 'write';
  if (['collabAgentToolCall', 'subAgentActivity'].includes(type)) return 'delegate';
  if (['agentMessage', 'reasoning', 'userMessage', 'plan', 'webSearch'].includes(type))
    return 'read';
  return 'unknown';
}

export class ExecutionObserver {
  private readonly actors = new Set<string>();
  private readonly endedActors = new Set<string>();
  private readonly calls = new Map<string, ExecutionCall>();
  private completed = false;
  private unproven = false;

  /** `proven` is the session's native children, kept across turns: a follow-up
   *  names an existing worker as `interacted`, never `started` again. */
  constructor(
    private readonly sessionId: string,
    private readonly proven = new Set<string>()
  ) {
    this.actors.add(sessionId);
  }

  take(method: string, params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const row = params as {
      threadId?: unknown;
      turnId?: unknown;
      item?: Record<string, unknown>;
      turn?: { status?: unknown };
    };
    // Every thread is heard, admitted or not: a child's frames can precede the
    // parent item that proves it, and unproven work must still be counted.
    if (typeof row.threadId !== 'string') return;
    if (method === 'turn/completed' && row.threadId === this.sessionId) this.completed = true;
    if (method === 'turn/completed' && row.threadId !== this.sessionId)
      this.endedActors.add(row.threadId);
    if (method === 'turn/started' && row.threadId !== this.sessionId)
      this.endedActors.delete(row.threadId);
    const item = row.item;
    if (
      !item ||
      typeof item.type !== 'string' ||
      typeof item.id !== 'string' ||
      !['item/started', 'item/completed'].includes(method)
    )
      return;
    const child = typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined;
    if (this.actors.has(row.threadId) && item.type === 'subAgentActivity' && child) {
      if (item.kind === 'started') this.admit(child);
      else if (item.kind === 'interacted' && this.proven.has(child)) this.actors.add(child);
      else if (item.kind === 'interacted') this.unproven = true;
      else if (item.kind === 'completed') this.endedActors.add(child);
    }
    if (
      this.actors.has(row.threadId) &&
      item.type === 'collabAgentToolCall' &&
      item.tool === 'spawn' &&
      Array.isArray(item.receiverThreadIds)
    ) {
      for (const actor of item.receiverThreadIds) if (typeof actor === 'string') this.admit(actor);
    }
    const kind = eligibility(item.type);
    if (kind === 'read') return;
    const key = JSON.stringify([row.threadId, item.id]);
    const previous = this.calls.get(key);
    this.calls.set(key, {
      actor: row.threadId,
      call: item.id,
      ...(typeof row.turnId === 'string' ? { context: row.turnId } : {}),
      eligibility: kind,
      settled: method === 'item/completed' || previous?.settled === true
    });
  }

  finish(): Promise<{ observed: boolean; calls: ExecutionCall[] }> {
    const calls = [...this.calls.values()];
    return Promise.resolve({
      observed:
        this.completed &&
        !this.unproven &&
        // Work on a thread nothing proved ours cannot be counted, so cannot be complete.
        calls.every((call) => this.actors.has(call.actor)) &&
        [...this.actors].every((actor) => actor === this.sessionId || this.endedActors.has(actor)),
      calls: calls.filter((call) => this.actors.has(call.actor))
    });
  }

  private admit(actor: string): void {
    this.actors.add(actor);
    this.proven.add(actor);
  }
}

/**
 * What a person runs to review the hooks natively. Their terminal is the
 * host's own shell; one that is not POSIX is named, since only it runs this
 * spelling.
 */
function reviewText(args: readonly string[]): string {
  const shell = platform.commands.shell('native');
  const where = shell === 'posix' ? '' : ` in ${commands.SHELL_NAMES[shell]}`;
  const line = platform.commands.render(
    'codex',
    args,
    { program: 'literal', args: 'quoted' },
    shell
  );
  const receiver = platform.commands.carries('codex', args, shell)
    ? ''
    : 'This command needs the standalone codex.exe; npm codex.ps1 and codex.cmd shims do not carry these hook flags. Ensure codex resolves to that executable before running it.\n\n';
  return `Run this${where} in the same Codex environment, then open /hooks and review the two Session flags hooks. Restart the owned session afterward.\n\n${receiver}${line}\n`;
}

const writers = ['Bash', 'apply_patch'];
const writerMatcher = `^(${writers.join('|')})$`;

export const integration: ExecutionIntegration = {
  // Session-flags hooks ran under Windows PowerShell 5.1 on 0.163.0 (observed 2026-10-27).
  hookShell: 'native',
  configure: async (command, directory) => {
    const args = ['PreToolUse', 'PostToolUse'].flatMap((event) => [
      '-c',
      `hooks.${event}=[{matcher=${JSON.stringify(writerMatcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=10}]}]`
    ]);
    await fs.writeFile(path.join(directory, 'codex-hook-review.txt'), reviewText(args), {
      mode: 0o600
    });
    return args;
  },
  decode: (payload, admission) => {
    if (!payload || typeof payload !== 'object') return undefined;
    const row = payload as Record<string, unknown>;
    if (
      row.session_id !== admission.sessionId ||
      typeof row.tool_use_id !== 'string' ||
      typeof row.cwd !== 'string' ||
      !writers.includes(String(row.tool_name))
    )
      return undefined;
    const edge =
      row.hook_event_name === 'PreToolUse'
        ? 'before'
        : row.hook_event_name === 'PostToolUse'
          ? 'after'
          : undefined;
    if (!edge || typeof row.turn_id !== 'string') return undefined;
    return {
      request: {
        cwd: row.cwd,
        owner: admission.owner,
        runtime: admission.runtime,
        actor: typeof row.agent_id === 'string' ? row.agent_id : admission.sessionId,
        call: row.tool_use_id,
        context: row.turn_id,
        edge
      }
    };
  }
};
