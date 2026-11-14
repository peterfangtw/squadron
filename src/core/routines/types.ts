import type * as compose from '../../ui/compose_doc';
import type * as model from '../model';
import type * as bridge from '../bridge/model';
import type * as processes from '../platform/processes';

export type Scope = { repoRoot: string; repoKey: string; launchCwd: string };
export type Schedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }
  | { kind: 'interval'; hours: number };
export type TargetChoice = { kind: 'default' } | { kind: 'explicit'; target: model.LaunchTarget };
export type Task = {
  doc: compose.ComposeDoc;
  delivered: string;
  workflowId?: string;
  targetChoice: TargetChoice;
  images: Record<string, { blobHash: string; name: string; mediaType: string }>;
  savedFromCwd: string;
};
export type TaskInput = Omit<Task, 'images'> & { attachments: compose.AttachmentPool };
export type Draft = { name: string; enabled: boolean; schedule: Schedule; task: TaskInput };
export type Handled = { key: string; outcome: 'completed' | 'skipped'; at: number; runId?: string };
export type Definition = {
  id: string;
  definitionRevision: number;
  name: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
  task: Task;
  schedule: Schedule;
  scheduleEpoch: string;
  anchorAt?: number;
  activeRunId?: string;
  handled: Handled[];
};
export type Member = {
  pid: number;
  startedAt: number;
  startSource: processes.StartSource;
  pgid?: number;
};
export type Observation = {
  generation: number;
  writer: Member;
  tenure: string;
  pending: boolean;
  coverage: 'observed' | 'limited';
  absent: boolean;
};
export type Attempt = {
  runId: string;
  routineId: string;
  definitionRevision: number;
  scheduleEpoch: string;
  occurrenceKey: string;
  requestedAt: number;
  cwd: string;
  nativeCwd: string;
  task: Task;
  target: model.LaunchTarget;
  owner: bridge.HostIdentity;
  phase: 'reserved' | 'spawning' | 'child' | 'bound' | 'admitted' | 'started' | 'stopped' | 'done';
  child?: Member;
  receiver?: bridge.ReceiverIdentity;
  sessionId?: string;
  promptAdmittedAt?: number;
  doneAt?: number;
  note?: string;
  reason?: string;
  members: Member[];
  observation?: Observation;
  cleanupConfirmed?: boolean;
  /** The root exited with no native identity retained: cleanup can never be proved. */
  cleanupUnprovable?: boolean;
};
export type Repository = {
  schema: 1;
  repoRoot: string;
  repoKey: string;
  revision: number;
  routines: Record<string, Definition>;
  attempts: Record<string, Attempt>;
};
export type Occurrence = { key: string; dueAt?: number; nextDueAt?: number; handled?: Handled };
export type Snapshot = { scope: Scope; repository: Repository };
export type Failure = {
  kind: 'conflict' | 'notFound' | 'unavailable' | 'invalid' | 'busy' | 'refused' | 'io';
  reason: string;
  definition?: Definition;
  attempt?: Attempt;
};
export type Result =
  { kind: 'ok'; snapshot: Snapshot; definition?: Definition; attempt?: Attempt } | Failure;
