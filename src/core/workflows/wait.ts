import type { WaitMember, WaitRecord, WorkflowWaitState } from '../coordination/wait';
import * as lineage from '../coordination/lineage';
import * as progress from './progress';
import * as workflows from './workflows';

/** Workflow waits use the runner's readiness, never a session's idle frame. */
export async function readWorkflowWaitStates(
  waits: readonly WaitRecord[],
  board: readonly WaitMember[],
  now: number
): Promise<Map<string, WorkflowWaitState>> {
  const pending = waits.filter((wait) => wait.workflow && !wait.failed);
  const states = new Map<string, WorkflowWaitState>();
  if (pending.length === 0) return states;
  const [definitions, edges] = await Promise.all([
    workflows.readWorkflows(),
    lineage.readLineage()
  ]);
  const members = board
    .filter((member) => !member.ended)
    .map((member) => ({
      ...member,
      idle: member.status === 'idle' && !member.hasCommand
    }));
  for (const wait of pending) {
    const identity = wait.workflow;
    const self = wait.requesterSessionId
      ? await progress.readProgress(wait.requesterSessionId)
      : undefined;
    const workflow = definitions.find((row) => row.id === identity?.workflowId);
    if (!self || !identity || !workflow || progress.runMoved(self, identity)) {
      states.set(wait.id, { state: 'stopped' });
      continue;
    }
    const siblings = await progress.readRunRecords(self);
    const anchor = self.lane ? siblings.find((record) => record.sessionId === self.anchor) : self;
    if (!anchor || (self.lane && progress.armingMiss(anchor, self))) {
      states.set(wait.id, { state: 'stopped' });
      continue;
    }
    const others = progress.runRecords(anchor, siblings);
    const opened = anchor.lanes ?? {};
    const found = progress.readiness({
      workflow,
      self,
      others,
      opened,
      members,
      lineage: edges,
      now
    });
    if (found.refused) {
      states.set(wait.id, { state: 'stopped' });
      continue;
    }
    if (
      !self.lane &&
      progress.unstarted({
        opened,
        records: [self, ...others],
        members,
        lineage: edges,
        now
      }).length > 0
    ) {
      states.set(wait.id, { state: 'ready' });
      continue;
    }
    if (found.stall) {
      states.set(wait.id, { state: 'stopped' });
    } else if (found.openLanes.length > 0 || found.waitPids.length === 0) {
      states.set(wait.id, { state: 'ready' });
    } else {
      // A fresh child can be idle before its first frame; re-check after the
      // measured startup window even if it never emits another frame.
      const fresh = Object.values(opened)
        .map((lane) => lane.openedAt + progress.FRESH_LANE_MS)
        .filter((at) => at > now);
      states.set(wait.id, {
        state: 'pending',
        ...(fresh.length === 0 ? {} : { checkAt: Math.min(...fresh) })
      });
    }
  }
  return states;
}
