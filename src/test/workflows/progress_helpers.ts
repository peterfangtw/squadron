import type { Progress, ProgressSeed, StepStatus } from '../../core/workflows/progress_store';
import type { Workflow } from '../../core/workflows/workflows';

export const workflow: Workflow = {
  id: 'ship',
  label: 'Ship it',
  steps: [
    { id: 'plan', label: 'Plan', prompt: 'plan it' },
    { id: 'build', label: 'Build', prompt: 'build it' },
    { id: 'commit', label: 'Commit', prompt: 'commit it' }
  ]
};

export const seed = (over: Partial<ProgressSeed> = {}): ProgressSeed => ({
  sessionId: 'sess-1',
  workflowId: workflow.id,
  label: workflow.label,
  steps: workflow.steps,
  ...over
});

export const reviewWf: Workflow = {
  id: 'review',
  label: 'Review loop',
  steps: [
    { id: 'impl', label: 'Implement', prompt: 'impl', output: 'step-notes' },
    { id: 'wire', label: 'Wiring', prompt: 'wire', needs: ['impl'] },
    {
      id: 'ui',
      label: 'UI',
      prompt: 'read ${step.impl.output}',
      lane: 's1',
      needs: ['impl']
    },
    { id: 'rw', label: 'Review wiring', prompt: 'rw', lane: 's2', needs: ['wire'] },
    { id: 'ru', label: 'Review UI', prompt: 'ru', lane: 's3', needs: ['ui'] },
    { id: 'aw', label: 'Apply wiring', prompt: 'aw', needs: ['rw'] },
    { id: 'au', label: 'Apply UI', prompt: 'au', lane: 's1', needs: ['ru'] },
    { id: 'int', label: 'Integrate', prompt: 'int', needs: ['aw', 'au'] },
    { id: 'riw', label: 'Review integration', prompt: 'riw', lane: 's2', needs: ['int'] },
    { id: 'riu', label: 'Review integration UI', prompt: 'riu', lane: 's3', needs: ['int'] },
    { id: 'ship', label: 'Ship', prompt: 'ship', needs: ['riw', 'riu'] }
  ]
};

export const row = (id: string, status: StepStatus) => ({ id, label: id, status });

export function laneRecord(
  seedProgress: (seed: ProgressSeed) => Progress,
  lane: string,
  steps: readonly [string, StepStatus][],
  over: Partial<Progress> = {}
): Progress {
  const seeded = seedProgress({
    sessionId: lane === '' ? 'anchor' : `sess-${lane}`,
    workflowId: reviewWf.id,
    label: reviewWf.label,
    steps: reviewWf.steps,
    lane,
    anchor: lane === '' ? undefined : 'anchor',
    pid: lane === '' ? 10 : undefined,
    now: 1
  });
  return { ...seeded, steps: steps.map(([id, status]) => row(id, status)), ...over };
}
