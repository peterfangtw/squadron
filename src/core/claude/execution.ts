import type { ExecutionCall, ExecutionStore } from '../checkpoint';
import type { ExecutionIntegration } from '../execution';
import * as execution from '../execution';

const writers = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const writerMatcher = `^(${writers.join('|')})$`;

export function eligibility(name: string): ExecutionCall['eligibility'] {
  if (writers.includes(name)) return 'write';
  if (['Read', 'Glob', 'Grep', 'ToolSearch', 'WebSearch', 'WebFetch', 'TaskOutput'].includes(name))
    return 'read';
  if (['Agent', 'Task'].includes(name)) return 'delegate';
  return 'unknown';
}

export function completedTask(payload: unknown, sessionId: string): string | undefined {
  const row = payload as Record<string, unknown> | null;
  return row?.session_id === sessionId &&
    row.type === 'system' &&
    row.subtype === 'task_notification' &&
    ['completed', 'failed', 'stopped'].includes(String(row.status)) &&
    typeof row.task_id === 'string'
    ? row.task_id
    : undefined;
}

export class ExecutionObserver {
  private readonly calls = new Map<string, { name: string; parent?: string; settled: boolean }>();
  private completed = false;

  constructor(
    private readonly sessionId: string,
    private readonly contextFile?: string
  ) {}

  take(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const row = payload as Record<string, unknown>;
    if (typeof row.session_id === 'string' && row.session_id !== this.sessionId) return;
    const parent = typeof row.parent_tool_use_id === 'string' ? row.parent_tool_use_id : undefined;
    if (row.type === 'result' && !parent) this.completed = true;
    const message = row.message as { content?: unknown } | undefined;
    const event = row.event as { type?: string; content_block?: unknown } | undefined;
    const blocks = Array.isArray(message?.content)
      ? message.content
      : event?.type === 'content_block_start'
        ? [event.content_block]
        : [];
    for (const value of blocks) {
      if (!value || typeof value !== 'object') continue;
      const block = value as Record<string, unknown>;
      if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        const previous = this.calls.get(block.id);
        this.calls.set(block.id, {
          name: block.name,
          ...(parent ? { parent } : {}),
          settled: previous?.settled === true
        });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = this.calls.get(block.tool_use_id);
        if (call) call.settled = true;
      }
    }
  }

  async finish(
    store: ExecutionStore,
    turn: string
  ): Promise<{ observed: boolean; calls: ExecutionCall[] }> {
    const children = this.contextFile
      ? await execution.readExecutionChildren(this.contextFile)
      : [];
    const calls: ExecutionCall[] = [];
    let observed =
      this.completed &&
      !children.some(
        (child) =>
          child.turn === turn &&
          execution.executionChildFor(children, this.sessionId, child.actor) &&
          child.ended === undefined
      );
    for (const [id, call] of this.calls) {
      let actor = this.sessionId;
      if (call.parent) {
        if (['read', 'delegate'].includes(eligibility(call.name))) continue;
        const parent = this.calls.get(call.parent);
        const actors = new Set(
          store.edges.filter((edge) => edge.call === id).map((edge) => edge.actor)
        );
        const child =
          actors.size === 1
            ? execution.executionChildFor(children, this.sessionId, [...actors][0] ?? '')
            : undefined;
        if (!parent || eligibility(parent.name) !== 'delegate' || !child || child.turn !== turn) {
          observed = false;
          continue;
        }
        actor = child.actor;
      }
      calls.push({ actor, call: id, eligibility: eligibility(call.name), settled: call.settled });
    }
    return { observed, calls };
  }
}

export const integration: ExecutionIntegration = {
  // No `shell` in our hook config, so Claude's default: bash (Git Bash on Windows, 2.1.296).
  hookShell: 'posix',
  configure: (command) =>
    Promise.resolve({
      hooks: Object.fromEntries(
        ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop'].map(
          (event) => [
            event,
            [
              {
                ...(event.startsWith('Subagent') ? {} : { matcher: writerMatcher }),
                hooks: [{ type: 'command', command, timeout: 10 }]
              }
            ]
          ]
        )
      )
    }),
  decode: (payload, admission, children) => {
    if (!payload || typeof payload !== 'object') return undefined;
    const row = payload as Record<string, unknown>;
    if (row.session_id !== admission.sessionId) return undefined;
    const actor = typeof row.agent_id === 'string' ? row.agent_id : admission.sessionId;
    if (row.hook_event_name === 'SubagentStart' && typeof row.agent_id === 'string') {
      return { child: { actor: row.agent_id, parent: admission.sessionId } };
    }
    if (row.hook_event_name === 'SubagentStop' && typeof row.agent_id === 'string')
      return { child: { actor: row.agent_id, parent: admission.sessionId, ended: true } };
    if (
      actor !== admission.sessionId &&
      !execution.executionChildFor(children, admission.sessionId, actor)
    )
      return undefined;
    if (
      typeof row.tool_use_id !== 'string' ||
      typeof row.tool_name !== 'string' ||
      typeof row.cwd !== 'string' ||
      eligibility(row.tool_name) !== 'write'
    )
      return undefined;
    const edge =
      row.hook_event_name === 'PreToolUse'
        ? 'before'
        : ['PostToolUse', 'PostToolUseFailure'].includes(String(row.hook_event_name))
          ? 'after'
          : undefined;
    if (!edge) return undefined;
    const response = row.tool_response as { backgroundTaskId?: unknown } | undefined;
    return {
      request: {
        cwd: row.cwd,
        owner: admission.owner,
        runtime: admission.runtime,
        actor,
        call: row.tool_use_id,
        edge,
        ...(typeof row.prompt_id === 'string' ? { context: row.prompt_id } : {}),
        ...(edge === 'after' && typeof response?.backgroundTaskId === 'string'
          ? { pending: true, task: response.backgroundTaskId }
          : {})
      }
    };
  }
};
