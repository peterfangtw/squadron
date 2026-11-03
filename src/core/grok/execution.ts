import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ExecutionCall, ExecutionStore } from '../checkpoint';
import type { ExecutionIntegration } from '../execution';
import * as execution from '../execution';

const writers = [
  'run_terminal_command',
  'write',
  'edit',
  'edit_file',
  'apply_patch',
  'search_replace'
];
const writerMatcher = `^(${writers.join('|')})$`;

export function eligibility(name: string): ExecutionCall['eligibility'] {
  if (writers.includes(name)) return 'write';
  if (['read_file', 'list_dir', 'grep', 'glob', 'get_command_or_subagent_output'].includes(name))
    return 'read';
  if (name === 'spawn_subagent') return 'delegate';
  return 'unknown';
}

/**
 * A terminal task and the session that reported it. A native child reports
 * under its own session ID; `endPendingExecution` accepts that actor only for
 * edges it or its proven descendants published.
 */
export function completedTask(
  method: string,
  params: unknown
): { actor: string; task: string } | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const row = params as {
    sessionId?: unknown;
    update?: {
      sessionUpdate?: unknown;
      task_snapshot?: { task_id?: unknown; completed?: unknown; owner_session_id?: unknown };
      rawOutput?: { type?: unknown; Result?: { task_id?: unknown; status?: unknown } };
    };
  };
  const actor = row.sessionId;
  if (typeof actor !== 'string' || !actor) return undefined;
  if (method === '_x.ai/task_completed') {
    const task = row.update?.task_snapshot;
    return row.update?.sessionUpdate === 'task_completed' &&
      task?.completed === true &&
      task.owner_session_id === actor &&
      typeof task.task_id === 'string'
      ? { actor, task: task.task_id }
      : undefined;
  }
  if (method !== 'session/update') return undefined;
  const output = row.update?.rawOutput;
  return output?.type === 'TaskOutput' &&
    typeof output.Result?.task_id === 'string' &&
    ['completed', 'failed', 'cancelled'].includes(String(output.Result.status))
    ? { actor, task: output.Result.task_id }
    : undefined;
}

export class ExecutionObserver {
  private readonly calls = new Map<string, ExecutionCall>();

  constructor(
    private readonly sessionId: string,
    private readonly contextFile?: string
  ) {}

  take(method: string, params: unknown): void {
    if (method !== 'session/update' || !params || typeof params !== 'object') return;
    const row = params as { sessionId?: unknown; update?: Record<string, unknown> };
    const update = row.update;
    if (
      !update ||
      typeof row.sessionId !== 'string' ||
      typeof update.toolCallId !== 'string' ||
      !['tool_call', 'tool_call_update'].includes(String(update.sessionUpdate))
    )
      return;
    const key = JSON.stringify([row.sessionId, update.toolCallId]);
    const previous = this.calls.get(key);
    const meta = update._meta as { 'x.ai/tool'?: { name?: unknown } } | undefined;
    const name = meta?.['x.ai/tool']?.name;
    this.calls.set(key, {
      actor: row.sessionId,
      call: update.toolCallId,
      eligibility:
        typeof name === 'string' ? eligibility(name) : (previous?.eligibility ?? 'unknown'),
      settled:
        previous?.settled === true ||
        ['completed', 'failed', 'cancelled'].includes(String(update.status))
    });
  }

  async finish(
    _store: ExecutionStore,
    turn: string
  ): Promise<{ observed: boolean; calls: ExecutionCall[] }> {
    const children = this.contextFile
      ? await execution.readExecutionChildren(this.contextFile)
      : [];
    const calls = [...this.calls.values()].filter(
      (call) =>
        call.actor === this.sessionId ||
        execution.executionChildFor(children, this.sessionId, call.actor)?.turn === turn
    );
    const ownedChildren = children.filter(
      (child) =>
        child.turn === turn && execution.executionChildFor(children, this.sessionId, child.actor)
    );
    const parents = new Set([this.sessionId, ...ownedChildren.map((child) => child.actor)]);
    // Grok 1.0.46's spawn result is Text without a child id. Cardinality checks
    // completeness; SubagentStart ancestry remains the ownership proof.
    return {
      observed:
        [...parents].every(
          (parent) =>
            calls.filter((call) => call.actor === parent && call.eligibility === 'delegate')
              .length ===
            new Set(
              ownedChildren.filter((child) => child.parent === parent).map((child) => child.actor)
            ).size
        ) && ownedChildren.every((child) => child.ended !== undefined),
      calls
    };
  }
}

export const integration: ExecutionIntegration = {
  // Plugin hooks ran under Windows PowerShell 5.1 on 1.0.70 (observed 2026-10-27).
  hookShell: 'native',
  configure: async (command, directory) => {
    const plugin = path.join(directory, 'plugin');
    await fs.mkdir(path.join(plugin, '.grok-plugin'), { recursive: true });
    await fs.mkdir(path.join(plugin, 'hooks'));
    await fs.writeFile(
      path.join(plugin, '.grok-plugin/plugin.json'),
      JSON.stringify({ name: 'squadron-execution', version: '1.0.0' })
    );
    await fs.writeFile(
      path.join(plugin, 'hooks/hooks.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'].map((event) => [
            event,
            [
              {
                ...(event.startsWith('Subagent') ? {} : { matcher: writerMatcher }),
                hooks: [{ type: 'command', command, timeout: 10 }]
              }
            ]
          ])
        )
      })
    );
    return plugin;
  },
  decode: (payload, admission, children) => {
    if (!payload || typeof payload !== 'object') return undefined;
    const row = payload as Record<string, unknown>;
    if (typeof row.sessionId !== 'string') return undefined;
    const parent =
      row.sessionId === admission.sessionId
        ? undefined
        : execution.executionChildFor(children, admission.sessionId, row.sessionId);
    if (row.sessionId !== admission.sessionId && !parent) return undefined;
    if (row.hookEventName === 'subagent_start' && typeof row.subagentId === 'string')
      return { child: { actor: row.subagentId, parent: row.sessionId } };
    if (row.hookEventName === 'subagent_stop' && typeof row.subagentId === 'string') {
      const original = execution.executionChildFor(children, admission.sessionId, row.subagentId);
      return original
        ? { child: { actor: row.subagentId, parent: original.parent, ended: true } }
        : undefined;
    }
    if (
      typeof row.toolUseId !== 'string' ||
      typeof row.toolName !== 'string' ||
      typeof row.cwd !== 'string' ||
      eligibility(row.toolName) !== 'write'
    )
      return undefined;
    const edge =
      row.hookEventName === 'pre_tool_use'
        ? 'before'
        : row.hookEventName === 'post_tool_use'
          ? 'after'
          : undefined;
    if (!edge) return undefined;
    const result = row.toolResult as
      { type?: unknown; status?: unknown; task_id?: unknown } | undefined;
    return {
      request: {
        cwd: row.cwd,
        owner: admission.owner,
        runtime: admission.runtime,
        actor: row.sessionId,
        call: row.toolUseId,
        edge,
        ...(edge === 'after' &&
        (result?.type === 'BackgroundTaskStarted' || result?.status === 'running')
          ? {
              pending: true,
              ...(typeof result.task_id === 'string' ? { task: result.task_id } : {})
            }
          : {})
      }
    };
  }
};
