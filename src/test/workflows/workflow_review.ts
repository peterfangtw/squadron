/**
 * §3d's eleven-step review, shared by the editor tests and the canvas tests.
 * Prompts stand in for the descriptions the preview fixture used to carry;
 * the lanes and the needs are the graph.
 */
import { cardView, groupView, stateMessage, workflowView, type Panel } from '../harness';

const board = (): GroupView[] => [groupView({ sessions: [cardView({ pid: 5, owned: true })] })];

/** The file the sheet offers, as it would arrive on the wire. */
export function review(): WorkflowView {
  return workflowView({
    id: 'review',
    label: 'Review loop',
    steps: [
      { id: 'impl', label: 'Implement this task', prompt: 'Read the task and split it.' },
      { id: 'wire', label: 'Do the wiring', prompt: 'Take the wiring half.', needs: ['impl'] },
      {
        id: 'ui',
        label: 'Do the UI',
        prompt: 'Take the UI half.',
        lane: 's1',
        needs: ['impl'],
        brand: 'claude',
        model: 'opus-5'
      },
      {
        id: 'rw',
        label: 'Review the wiring',
        prompt: 'Review the wiring diff.',
        lane: 's2',
        needs: ['wire'],
        brand: 'claude',
        model: 'sonnet-5',
        effort: 'medium'
      },
      {
        id: 'ru',
        label: 'Review the UI',
        prompt: 'Review the UI diff.',
        lane: 's3',
        needs: ['ui'],
        brand: 'claude',
        model: 'sonnet-5',
        effort: 'medium'
      },
      {
        id: 'aw',
        label: 'Apply the findings',
        prompt: 'Apply the wiring findings.',
        needs: ['rw']
      },
      {
        id: 'au',
        label: 'Apply the findings',
        prompt: 'Apply the UI findings.',
        lane: 's1',
        needs: ['ru']
      },
      {
        id: 'int',
        label: 'Converge and integrate',
        prompt: 'Merge both halves.',
        needs: ['aw', 'au']
      },
      {
        id: 'riw',
        label: 'Review the integration',
        prompt: 'Review wiring regressions.',
        lane: 's2',
        needs: ['int']
      },
      {
        id: 'riu',
        label: 'Review the integration',
        prompt: 'Review UI regressions.',
        lane: 's3',
        needs: ['int']
      },
      {
        id: 'ship',
        label: 'Converge, test, commit',
        prompt: 'Run the gate, then commit.',
        needs: ['riw', 'riu']
      }
    ]
  });
}

/** The catalog the review's chips read. Haiku has no effort ladder. */
export const LANE_MODELS: ModelView[] = [
  {
    value: 'opus-5',
    name: 'Opus 5',
    id: 'opus-5',
    brand: 'claude',
    window: 200_000,
    efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
    defaultEffort: 'high'
  },
  {
    value: 'sonnet-5',
    name: 'Sonnet 5',
    id: 'sonnet-5',
    brand: 'claude',
    window: 200_000,
    efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }],
    defaultEffort: 'high'
  },
  { value: 'haiku', name: 'Haiku', id: 'haiku', brand: 'claude', window: 200_000 }
];

/** Edit is on every row, as the row's own button. Duplicated rather than
 *  imported from the editor tests, which would run that file's cases twice. */
function edit(p: Panel, label: string): void {
  p.window.document.querySelector<HTMLElement>('.card')?.click();
  p.window.document.querySelector<HTMLElement>('#bottomhub .wmore')?.click();
  [...p.window.document.querySelectorAll<HTMLElement>('#bottomdrawer-body .wsrow')]
    .find((el) => (el.querySelector('.nm')?.textContent ?? '').includes(label))
    ?.querySelector<HTMLElement>('.act.edit')
    ?.click();
}

/** Open `file` in the editor. The canvas tests mount through this, which is
 *  the mount a reader gets. */
export function openWorkflow(p: Panel, file: WorkflowView): void {
  p.push(stateMessage(board(), { workflows: [file], models: LANE_MODELS }));
  edit(p, file.label);
}

export function openReview(p: Panel): void {
  openWorkflow(p, review());
}
