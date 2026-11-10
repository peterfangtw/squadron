import { DEFAULT_BRAND, isBrand } from './brands';
import * as adapters from './adapter';
import * as names from './model_names';
import type { BrandId, LaunchTarget } from './model';

export type ModelListing = {
  brands: {
    brand: BrandId;
    installed: boolean | null;
    signedIn: boolean | null;
    source: adapters.CliAdapter['modelSource'];
  }[];
  models: {
    brand: BrandId;
    model: string;
    name: string;
    context?: number;
    gated?: true;
    legacy?: true;
    efforts?: readonly { value: string; description?: string }[];
    defaultEffort?: string;
    preferredEffort?: string;
  }[];
};

export function modelListing(
  availability: readonly adapters.BrandAvailability[],
  efforts: Readonly<Record<string, string>> = {}
): ModelListing {
  const models = adapters.offeredModels(availability);
  return {
    brands: availability.flatMap((available) => {
      const cli = adapters.adapter(available.brand);
      return cli
        ? [
            {
              brand: available.brand,
              installed: available.installed ?? null,
              signedIn: available.signedIn ?? null,
              source: cli.modelSource
            }
          ]
        : [];
    }),
    models: models.map((row) => ({
      brand: row.brand,
      model: row.value,
      name: row.name,
      ...(row.window === undefined ? {} : { context: row.window }),
      ...(row.gated ? { gated: true as const } : {}),
      ...(row.legacy ? { legacy: true as const } : {}),
      ...(row.efforts?.length
        ? {
            efforts: row.efforts,
            defaultEffort: row.defaultEffort,
            preferredEffort: names.effortFor(models, row.value, row.window, efforts[row.value])
          }
        : {})
    }))
  };
}

export type RemoteModels = {
  incomingAccess?: import('./bridge/model').IncomingAccess;
  models: ModelListing;
  remoteSelection?: { defaultTarget: LaunchTarget };
};
export type SelectionSource = 'catalog' | 'default';

export function listingDefault(
  listing: ModelListing,
  setting: string,
  window: number | undefined
): LaunchTarget {
  const models = listing.models.map((row) => ({
    ...row,
    id: row.model,
    value: row.model,
    window: row.context
  }));
  const efforts = Object.fromEntries(
    listing.models.flatMap((row) =>
      row.preferredEffort === undefined ? [] : [[row.model, row.preferredEffort]]
    )
  );
  return names.defaultPick(models, setting, window, efforts) ?? {};
}

export function catalogTarget(listing: ModelListing, target: LaunchTarget): boolean {
  const row = listing.models.find(
    (row) =>
      row.brand === target.brand && row.model === target.model && row.context === target.window
  );
  return (
    row !== undefined &&
    (row.efforts?.length
      ? row.efforts.some((effort) => effort.value === target.effort)
      : target.effort === undefined)
  );
}

export function isLaunchTarget(value: unknown): value is LaunchTarget {
  if (!isRecord(value)) return false;
  return (
    (value.brand === undefined || isBrand(value.brand)) &&
    (value.model === undefined || nonempty(value.model)) &&
    (value.window === undefined || positive(value.window)) &&
    (value.effort === undefined || nonempty(value.effort))
  );
}

export function isModelListing(value: unknown): value is ModelListing {
  if (!isRecord(value) || !Array.isArray(value.brands) || !Array.isArray(value.models))
    return false;
  return (
    value.brands.every(
      (row: unknown) =>
        isRecord(row) &&
        isBrand(row.brand) &&
        (row.installed === null || typeof row.installed === 'boolean') &&
        (row.signedIn === null || typeof row.signedIn === 'boolean') &&
        (row.source === 'maintained' || row.source === 'account')
    ) &&
    value.models.every(
      (row: unknown) =>
        isRecord(row) &&
        isBrand(row.brand) &&
        nonempty(row.model) &&
        nonempty(row.name) &&
        (row.context === undefined || positive(row.context)) &&
        (row.gated === undefined || row.gated === true) &&
        (row.legacy === undefined || row.legacy === true) &&
        (row.efforts === undefined
          ? row.defaultEffort === undefined && row.preferredEffort === undefined
          : Array.isArray(row.efforts) &&
            row.efforts.length > 0 &&
            row.efforts.every(
              (effort: unknown) =>
                isRecord(effort) &&
                nonempty(effort.value) &&
                (effort.description === undefined || typeof effort.description === 'string')
            ) &&
            row.efforts.some((effort: { value: unknown }) => effort.value === row.defaultEffort) &&
            (row.preferredEffort === undefined ||
              row.efforts.some(
                (effort: { value: unknown }) => effort.value === row.preferredEffort
              )))
    )
  );
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function remoteTarget(
  start: import('./coordination/serve_owned').RemoteStart,
  models: ModelListing,
  fallback: () => LaunchTarget | undefined
):
  | { ok: true; target?: LaunchTarget }
  | { ok: false; reason: string; outcome: 'stopped'; selectionInvalid: true } {
  if (start.selection === undefined)
    return { ok: true, target: start.brand === undefined ? fallback() : { brand: start.brand } };
  const target: LaunchTarget = {
    ...(start.brand === undefined ? {} : { brand: start.brand }),
    ...(start.model === undefined ? {} : { model: start.model }),
    ...(start.window === undefined ? {} : { window: start.window }),
    ...(start.effort === undefined ? {} : { effort: start.effort })
  };
  const known = models.models.some(
    (row) => row.brand === (target.brand ?? DEFAULT_BRAND) && row.model === target.model
  );
  const valid =
    isLaunchTarget(target) &&
    (start.selection === 'catalog' || known
      ? catalogTarget(models, { ...target, brand: target.brand ?? DEFAULT_BRAND })
      : target.effort === undefined);
  return valid
    ? { ok: true, target }
    : {
        ok: false,
        reason: 'That model, context or effort is no longer available. Choose again.',
        outcome: 'stopped',
        selectionInvalid: true
      };
}
