import { DEFAULT_BRAND } from '../brands';
import * as listings from '../model_listing';
import type { LaunchTarget } from '../model';
import type { Offered } from './jobs';
import type { Place } from './model';
import * as words from './words';

export type PickerDraft = {
  generation: number;
  page: number;
  published: number;
  destination: Place;
  folder?: Offered;
  catalog?: listings.RemoteModels;
  target?: LaunchTarget;
  source?: listings.SelectionSource;
  issue?: string;
  /** The model stage lists rows marked `legacy` too. */
  older?: true;
} & (
  | { stage: 'folder'; folder?: never; catalog?: never; target?: never; source?: never }
  | { stage: 'model'; folder: Offered; target?: never; source?: never }
  | {
      stage: 'effort';
      folder: Offered;
      catalog: listings.RemoteModels;
      target: LaunchTarget;
      source: 'catalog';
    }
  | { stage: 'starting'; folder: Offered; target: LaunchTarget }
);
export type Choice = {
  command:
    'folder' | 'model' | 'effort' | 'default' | 'older' | 'back' | 'page' | 'retry' | 'cancel';
  value?: string;
  index?: number;
};
export type PickerPage = { body: string; choices: { label: string; choice: Choice }[] };

export type Selection =
  | { kind: 'ignore' }
  | { kind: 'cancel' }
  | { kind: 'folder'; value?: string }
  | { kind: 'discover'; folder: Offered }
  | { kind: 'advance'; draft: PickerDraft }
  | { kind: 'launch'; target: LaunchTarget; source: listings.SelectionSource | undefined };

type Revision =
  | { kind: 'reset' }
  | { kind: 'discover'; folder: Offered }
  | { kind: 'catalog'; result: { catalog: listings.RemoteModels } | { issue: string } }
  | { kind: 'advance' }
  | { kind: 'start'; target: LaunchTarget; source: listings.SelectionSource | undefined }
  | { kind: 'reload' };

export function initial(destination: Place, folder?: Offered): PickerDraft {
  return {
    generation: 0,
    page: 0,
    published: 0,
    destination,
    ...(folder ? { stage: 'model', folder } : { stage: 'folder' })
  };
}

export function accepts(draft: PickerDraft | undefined, generation: number | undefined): boolean {
  return draft !== undefined && draft.stage !== 'starting' && generation === draft.generation;
}

export function expired(
  held: { expiresAt: number; picker?: PickerDraft } | undefined,
  now: number
): boolean {
  return held !== undefined && held.picker?.stage !== 'starting' && now >= held.expiresAt;
}

export function folderAvailable(folder: Offered, open: readonly Offered[]): boolean {
  return open.some((one) => one.folder === folder.folder && one.windowId === folder.windowId);
}

export function choose(
  draft: PickerDraft,
  action: { generation?: number; choice?: Choice }
): Selection {
  const choice = action.choice;
  if (!accepts(draft, action.generation) || !choice) return { kind: 'ignore' };
  if (choice.command === 'cancel') return { kind: 'cancel' };
  if (choice.command === 'page')
    return choice.index === undefined
      ? { kind: 'ignore' }
      : { kind: 'advance', draft: { ...draft, page: choice.index } };
  if (choice.command === 'folder' && draft.stage === 'folder')
    return { kind: 'folder', value: choice.value };
  if ((choice.command === 'back' && draft.stage === 'effort') || choice.command === 'retry')
    return draft.folder ? { kind: 'discover', folder: draft.folder } : { kind: 'ignore' };
  if (draft.issue || !draft.folder || !draft.catalog) return { kind: 'ignore' };
  if (choice.command === 'older' && draft.stage === 'model') {
    const { older, ...rest } = draft;
    return { kind: 'advance', draft: { ...rest, ...(older ? {} : { older: true }), page: 0 } };
  }
  if (choice.command === 'default' && draft.stage === 'model') {
    const target = draft.catalog.remoteSelection?.defaultTarget ?? {};
    const source = listings.catalogTarget(draft.catalog.models, {
      ...target,
      brand: target.brand ?? DEFAULT_BRAND
    })
      ? 'catalog'
      : 'default';
    return {
      kind: 'launch',
      target,
      source: draft.catalog.remoteSelection === undefined ? undefined : source
    };
  }
  if (
    choice.command === 'model' &&
    draft.stage === 'model' &&
    draft.catalog.remoteSelection !== undefined
  ) {
    const row = draft.catalog.models.models[choice.index ?? -1];
    if (!row) return { kind: 'ignore' };
    const target = {
      brand: row.brand,
      model: row.model,
      ...(row.context === undefined ? {} : { window: row.context })
    };
    return (row.efforts?.length ?? 0) > 1
      ? {
          kind: 'advance',
          draft: {
            ...draft,
            stage: 'effort',
            catalog: draft.catalog,
            target,
            source: 'catalog',
            page: 0
          }
        }
      : {
          kind: 'launch',
          target: { ...target, ...(row.efforts?.[0] ? { effort: row.efforts[0].value } : {}) },
          source: 'catalog'
        };
  }
  if (choice.command === 'effort' && draft.stage === 'effort') {
    const target = { ...draft.target, effort: choice.value };
    if (listings.catalogTarget(draft.catalog.models, target))
      return { kind: 'launch', target, source: 'catalog' };
  }
  return { kind: 'ignore' };
}

export function revise(draft: PickerDraft, revision: Revision): PickerDraft {
  switch (revision.kind) {
    case 'reset':
      return { ...initial(draft.destination), generation: draft.generation };
    case 'discover':
      return {
        ...initial(draft.destination, revision.folder),
        generation: draft.generation + 1,
        ...(draft.older ? { older: true } : {})
      };
    case 'catalog':
      if (draft.stage !== 'model') return draft;
      return 'catalog' in revision.result
        ? { ...draft, catalog: revision.result.catalog }
        : { ...draft, issue: revision.result.issue };
    case 'advance':
      return { ...draft, generation: draft.generation + 1, published: 0 };
    case 'start':
      if (!draft.folder) return draft;
      return {
        ...draft,
        stage: 'starting',
        folder: draft.folder,
        target: revision.target,
        source: revision.source,
        generation: draft.generation + 1
      };
    case 'reload':
      return draft.stage === 'starting' && !draft.issue
        ? { ...draft, issue: words.startUnknownAfterReload }
        : draft;
  }
}

export function startRecovery(
  draft: PickerDraft,
  failure: { reason: string; notStarted?: true }
):
  | { kind: 'retry'; folder: Offered; reason: string }
  | { kind: 'uncertain'; draft: PickerDraft; reason: string } {
  if (failure.notStarted === true && draft.folder)
    return { kind: 'retry', folder: draft.folder, reason: failure.reason };
  const issue = words.startUnknown(failure.reason);
  return { kind: 'uncertain', draft: { ...draft, issue }, reason: issue };
}

export function isPickerDraft(value: unknown): value is PickerDraft {
  if (
    !object(value) ||
    !['folder', 'model', 'effort', 'starting'].includes(String(value.stage)) ||
    !integer(value.generation) ||
    !integer(value.page) ||
    !integer(value.published) ||
    !isPlace(value.destination) ||
    (value.issue !== undefined && typeof value.issue !== 'string') ||
    (value.older !== undefined && value.older !== true)
  )
    return false;
  if (
    value.folder !== undefined &&
    (!object(value.folder) ||
      typeof value.folder.folder !== 'string' ||
      typeof value.folder.windowId !== 'string')
  )
    return false;
  if (
    value.catalog !== undefined &&
    (!object(value.catalog) ||
      !listings.isModelListing(value.catalog.models) ||
      (value.catalog.remoteSelection !== undefined &&
        (!object(value.catalog.remoteSelection) ||
          !listings.isLaunchTarget(value.catalog.remoteSelection.defaultTarget))))
  )
    return false;
  if (value.target !== undefined && !listings.isLaunchTarget(value.target)) return false;
  if (value.source !== undefined && value.source !== 'catalog' && value.source !== 'default')
    return false;
  if (value.stage !== 'folder' && value.folder === undefined) return false;
  if (
    value.stage === 'folder' &&
    (value.folder !== undefined ||
      value.catalog !== undefined ||
      value.target !== undefined ||
      value.source !== undefined)
  )
    return false;
  if (value.stage === 'model' && (value.target !== undefined || value.source !== undefined))
    return false;
  if (
    value.stage === 'effort' &&
    (value.catalog === undefined || value.target === undefined || value.source !== 'catalog')
  )
    return false;
  return value.stage !== 'starting' || value.target !== undefined;
}

function isPlace(value: unknown): value is Place {
  return (
    object(value) &&
    (typeof value.home === 'string' ||
      typeof value.under === 'string' ||
      (object(value.conversation) &&
        typeof value.conversation.anchor === 'string' &&
        typeof value.conversation.latest === 'string'))
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
