/**
 * Compose one state push: plain inputs in, the `type: 'state'` message out.
 *
 * Gather (disk, configuration, terminals, markdown) stays in the host.
 * Decisions about what the board shows live here so a test can call them.
 */

import { Arrangement } from '../core/arrange';
import { Session } from '../core/model';
import * as platform from '../core/platform';
import type { PathKey } from '../core/platform/paths';
import type { Model } from '../core/model_names';
import { ReadWorkflow, WorkflowEdit } from '../core/workflows/workflows';
import { WorkflowOrder, orderWorkflows } from '../core/workflows/workflow_order';
import { warmConfig } from '../core/cache_ttl';
import { DEFAULT_WARM_POLICY, type WarmPolicy } from '../core/warm_policy';
import type { ServerContext } from './server_views';
import { buildGroups, modelViews, warmView } from './views';

/** Activity clocks are sampled by the independent board sources. Every other
 * owned fact invalidates discovery; pending/outbox details still refresh the dock. */
export function ownedDiscoveryKey(
  sessions: readonly Session[],
  generations: readonly (number | undefined)[]
): string {
  return JSON.stringify({
    sessions: sessions.map(({ updatedAt: _activity, ...session }) => session),
    generations
  });
}

/** Streaming changes must not starve a board waiting on native lifecycle changes. */
export function ownedLifecycleKey(sessions: readonly Session[]): string {
  return JSON.stringify(
    sessions.map(({ pid, startedAt, closing, endStuck, endFailure }) => [
      pid,
      startedAt,
      closing,
      endStuck,
      endFailure
    ])
  );
}

export function commitOwnedBoard(
  captured: string,
  current: readonly Session[],
  effects: { commit(): void; refresh(): void }
): boolean {
  if (captured !== ownedLifecycleKey(current)) {
    effects.refresh();
    return false;
  }
  effects.commit();
  return true;
}

/**
 * Everything `buildState` needs, already gathered by the host.
 *
 * Workflows arrive whole (`ReadWorkflow`). What crosses is `toWorkflowView` —
 * the fields the editor lays out. `check` stays here. The selected thread is
 * a separate `thread` / `threadPatch` message, not part of this snapshot.
 */
export type StateInputs = {
  sessions: readonly Session[];
  workspaceFolder: string | undefined;
  /** Canonical managed launch root, independent of IDE workspace identity. */
  scratchRoot?: string;
  folderRoots: ReadonlyMap<string, string>;
  arrangements: ReadonlyMap<PathKey, Arrangement>;
  /** Machine-wide accounts; absent until the first auth poll. */
  accounts?: AccountView[];
  /** The usage chip's windows while `accounts` is absent; see `StateMessage`. */
  usageWindows?: { id: string; short: string }[];
  onboardingDone?: boolean;
  skillInstall?: SkillInstallView[];
  /** MCP servers the board's repos configure; absent until the first read. */
  mcp?: McpView;
  machine: MachineView | undefined;
  /** Whether the café is on. Defaults on in the host, so this is the one flag
   *  whose false is a choice rather than an absence. */
  cafe: boolean;
  /** Whether Remote holds the machine with nothing working. Defaults on. */
  cafeRemote: boolean;
  /** Whether a session with Warm on holds the machine. Defaults on. */
  cafeWarm: boolean;
  /** A session in this window has Warm on. */
  warmOn: boolean;
  /** The coffee holding this machine awake, already merged across windows by
   *  `panel.ts`. Absent draws no cup at all — off this platform, or the setting
   *  off. */
  awake?: AwakeView;
  /** Where the reader dragged the cup, out of workspace storage. */
  cafeAt?: { x: number; y: number };
  /** Remote in this window, already in words (`ui/remote_view.ts`). Absent in
   *  a host without `RemoteHost`, or when its view could not be read. */
  remote?: RemoteStateView;
  orchestrators: boolean;
  skipPermissions: boolean;
  executionCapture: boolean;
  soundLevel: SoundLevel;
  /** Whether the servers line is drawn — the experiment behind the gear. Off
   *  means `servers` below is absent too, since the host gathers nothing. */
  devServers: boolean;
  /** Whether the chick is on the board. */
  mascot: boolean;
  /** Whether a session this window starts from now on is kept warm. */
  warmCache: boolean;
  /** The warm figures the host read off its settings. Absent reads as the
   *  defaults; `panel.ts` always states it. */
  warmPolicy?: WarmPolicy;
  theme: ThemeName;
  /** What a new session starts on, and what the gear may set it to. Where a
   *  draft's pick opens and what a resume passes; the start itself states the
   *  answer either way. */
  model: string;
  /** The window beside `model`, in tokens; absent when the setting is unset.
   *  Two rows of the flattened catalog share a `value`, so the menu needs both
   *  to tick one of them (`board_settings.ts`). */
  contextWindow?: number;
  /** `squadron.efforts`, by model `value`. What a new start on that model is
   *  to reason at, seeding a draft and the resume picker the way `model` does
   *  — `startOwned` reads no setting, so an effort that stops here reaches no
   *  session. */
  efforts: Readonly<Record<string, string>>;
  /** Every model this machine can start a session on, already filtered to the
   *  brands it can run and already in the catalog's rank. */
  models: readonly Model[];
  tickets: TicketView[] | undefined;
  ticketSource: TicketSourceStatus | undefined;
  workflows: readonly ReadWorkflow[];
  /** Structurally broken files the editor can open. Not part of `workflows`. */
  workflowEdits: readonly WorkflowEdit[];
  /** The order the reader has stated for the runnable list. Absent is the
   *  machine that has stated nothing, and gets label order. */
  workflowOrder: WorkflowOrder | undefined;
  /** The servers section's whole input, gathered host-side. Absent on a machine
   *  whose groups are not repositories, which draws no section. */
  servers?: ServerContext;
  skills: ReadonlyMap<string, import('../core/skills').SkillNames>;
  editorSkills?: readonly string[];
  /** The clock `CardView.warm` is decided at — the scheduler's next ping is a
   *  moment, and whether it is due yet is a question about now. */
  now: number;
};

/**
 * What the panel may list, peek, and load into the editor.
 *
 * `prompt` is the form field; a step that only had `uses` surfaces that slash
 * line as `prompt` so edit is not blank. `lane`, `needs`, `model`, `effort`
 * and `brand` cross so the canvas can place the file and a chip can write
 * them back. Shell `check` stays host-only. An empty lane or an empty `needs`
 * is the armed session and "no edge", so neither key is sent.
 */
export function toWorkflowView(workflow: ReadWorkflow): WorkflowView {
  return {
    id: workflow.id,
    label: workflow.label,
    ...(workflow.lanes?.length ? { lanes: [...workflow.lanes] } : {}),
    steps: workflow.steps.map(stepView)
  };
}

function stepView(s: {
  id: string;
  label: string;
  prompt?: string;
  uses?: string;
  lane?: string;
  needs?: readonly string[];
  brand?: BrandId;
  model?: string;
  effort?: string;
}): WorkflowStepView {
  return {
    id: s.id,
    label: s.label,
    prompt: s.prompt ?? s.uses ?? '',
    ...(s.lane ? { lane: s.lane } : {}),
    ...(s.needs && s.needs.length > 0 ? { needs: [...s.needs] } : {}),
    ...(s.brand ? { brand: s.brand } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.effort ? { effort: s.effort } : {})
  };
}

/**
 * Every workflow, in the reader's order.
 *
 * **The one place that question is answered.** Both painters — the sheet and
 * the composer — map this array in the order it arrives, and `picker()` filters
 * without ever sorting, so a fold here is a fold everywhere. That is what makes
 * one stated order serve both surfaces without either being told about the file.
 */
export function workflowViews(
  workflows: readonly ReadWorkflow[],
  order: WorkflowOrder | undefined
): WorkflowView[] {
  return orderWorkflows(workflows, order).map(toWorkflowView);
}

/**
 * Edits in the reader's order.
 *
 * A separate array from {@link workflowViews}: the sheet draws them after the
 * runnable rows, and the composer must not offer a file that cannot run.
 */
function workflowEditViews(
  edits: readonly WorkflowEdit[],
  order: WorkflowOrder | undefined
): WorkflowEditView[] {
  return orderWorkflows(edits, order).map((edit) => ({
    repair: true,
    id: edit.id,
    label: edit.label,
    ...(edit.lanes?.length ? { lanes: [...edit.lanes] } : {}),
    steps: edit.steps.map(stepView),
    reasons: [...edit.reasons]
  }));
}

/**
 * A state message as the thing `panel.ts` compares two pushes by — everything
 * that is board state, serialized, with the machine readings' values left out.
 *
 * **Why a string and not a deep compare.** The message is a tree of a few
 * hundred small objects, `JSON.stringify` on it is the same order of cost as the
 * `postMessage` that skipping it saves, and every field on the way down is
 * built by `buildState` in a fixed order — so two identical polls produce
 * identical text. A hand-written deep compare would be a second description of
 * the wire format, kept in step with the first by nothing.
 *
 * **`machine`'s values are what is left out, and they have to be.** The load is
 * two tick samples of a running machine and the memory is read off the OS; both
 * differ on every poll whether or not anything happened, so a comparison
 * including them would never once say "unchanged" — see
 * `docs/tasks/TASK_done_panel_repaint_cost.md`. They ride a slower beat of
 * their own instead, which is `panel.ts`'s `UNCHANGED_MS`.
 *
 * **Its shape stays in**: which readings exist, and whether memory answered.
 * The nav draws a missing reading as one being fetched, so a reading arriving
 * ends a wait — and skipped as unchanged, the first CPU sample on an idle board
 * sat behind that wait for the whole 15s. The shape moves once per arrival, not
 * per poll.
 *
 * Nothing else may join the exclusion. A field left out here is a field the
 * panel can stop repainting: `awake` was the other candidate and was fixed
 * rather than excluded — its level came off the wire entirely (Step 2), so what
 * remains is an epoch that only moves on a refill.
 */
export function stateKey(message: StateMessage): string {
  const { machine, ...board } = message;
  const shape = machine && {
    cpu: machine.cpu !== undefined,
    memory: machine.memory === undefined ? 'unread' : machine.memory === null ? 'none' : 'read'
  };
  return JSON.stringify({ ...board, machine: shape });
}

/**
 * The whole board's shape for one poll. Synchronous and free of `vscode`.
 *
 * Always sets `workflows` and `workflowEdits` to arrays (possibly empty):
 * that matches what `refresh()` posts. Absence vs empty is a webview concern
 * (`?? []`); the host path always maps.
 */
export function buildState(inputs: StateInputs): StateMessage {
  const groups = buildGroups(
    [...inputs.sessions],
    inputs.workspaceFolder,
    new Map(inputs.folderRoots),
    new Map(inputs.arrangements),
    inputs.servers,
    inputs.scratchRoot
  );
  const byPid = new Map(inputs.sessions.map((s) => [s.pid, s]));
  const policy = inputs.warmPolicy ?? DEFAULT_WARM_POLICY;
  const skillsAt = new Map(
    [...inputs.skills].map(([dir, names]) => [platform.paths.key(dir), names] as const)
  );
  for (const group of groups) {
    const skills = skillsAt.get(platform.paths.key(group.cwd));
    if (skills) group.skillsByBrand = skills;
    for (const card of group.sessions) {
      const session = byPid.get(card.pid);
      if (session) card.warm = warmView(session, inputs.now, policy);
    }
  }
  const skills = inputs.editorSkills ?? [];
  return {
    type: 'state',
    groups,
    defaultCwd: inputs.workspaceFolder ?? inputs.scratchRoot,
    defaultSkillsByBrand: inputs.workspaceFolder
      ? skillsAt.get(platform.paths.key(inputs.workspaceFolder))
      : undefined,
    accounts: inputs.accounts,
    usageWindows: inputs.usageWindows,
    onboarding: !inputs.onboardingDone && !!inputs.accounts,
    skillInstall: inputs.skillInstall,
    mcp: inputs.mcp,
    machine: inputs.machine,
    cafe: inputs.cafe,
    cafeRemote: inputs.cafeRemote,
    cafeWarm: inputs.cafeWarm,
    warmOn: inputs.warmOn,
    // Named here rather than spread in from the caller. `buildState` copies
    // field by field, and an object spread does *not* get TypeScript's
    // excess-property check — so a field the caller passes and this forgets is
    // dropped in silence, which is exactly how the cup shipped invisible.
    awake: inputs.awake,
    cafeAt: inputs.cafeAt,
    remote: inputs.remote,
    orchestrators: inputs.orchestrators,
    skipPermissions: inputs.skipPermissions,
    executionCapture: inputs.executionCapture,
    soundLevel: inputs.soundLevel,
    devServers: inputs.devServers,
    mascot: inputs.mascot,
    warmCache: inputs.warmCache,
    warmConfig: warmConfig(policy),
    theme: inputs.theme,
    model: inputs.model,
    contextWindow: inputs.contextWindow,
    efforts: inputs.efforts,
    models: modelViews(inputs.models),
    tickets: inputs.tickets,
    ticketSource: inputs.ticketSource,
    workflows: workflowViews(inputs.workflows, inputs.workflowOrder),
    workflowEdits: workflowEditViews(inputs.workflowEdits, inputs.workflowOrder),
    // Named, not spread, for the reason stated above `awake` — and undefined
    // rather than `[]`, so the editor's one test is the same as the composer's.
    skills: skills.length ? [...skills] : undefined
  };
}
