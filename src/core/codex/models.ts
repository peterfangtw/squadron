/** Account-dependent Codex model catalog, paged and replaced atomically. */

import type { Model } from '../model_names';
import { catalogFor } from '../catalog';
import type { CodexRpc } from './runtime';

const RANK = new Map(catalogFor('codex').map((model, index) => [model.value, index]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function effortStrings(value: unknown): { value: string; description?: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts: { value: string; description?: string }[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.reasoningEffort !== 'string' ||
      (entry.description !== undefined && typeof entry.description !== 'string')
    ) {
      return undefined;
    }
    efforts.push({
      value: entry.reasoningEffort,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {})
    });
  }
  // `model/list` states them weakest-first — low, medium, high, xhigh, max,
  // ultra on 0.151.0. The panel shows every brand's strongest first, so the
  // server's own ladder is reversed rather than ranked against a scale of ours:
  // only the account row knows what it offers.
  return efforts.reverse();
}

export function modelPage(value: unknown): { models: Model[]; next?: string } | undefined {
  if (!isRecord(value) || !Array.isArray(value.data)) return undefined;
  const models: Model[] = [];
  for (const entry of value.data) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.hidden !== 'boolean') return undefined;
    if (entry.hidden === true) continue;
    if (
      typeof entry.isDefault !== 'boolean' ||
      typeof entry.defaultReasoningEffort !== 'string' ||
      !Array.isArray(entry.inputModalities) ||
      !entry.inputModalities.every((item) => typeof item === 'string')
    ) {
      return undefined;
    }
    const model = typeof entry.model === 'string' && entry.model ? entry.model : undefined;
    const id = typeof entry.id === 'string' && entry.id ? entry.id : model;
    if (!model || !id) return undefined;
    const efforts = effortStrings(entry.supportedReasoningEfforts);
    if (!efforts) return undefined;
    const name =
      typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim()
        : id;
    const authored = catalogFor('codex').filter((row) => row.value === model || row.id === id);
    const bases: readonly Model[] = authored.length
      ? authored
      : [{ value: model, id, name, brand: 'codex', readings: [model, id] }];
    for (const base of bases) {
      models.push({
        ...base,
        // Launch spellings belong to the live account row.
        value: model,
        id,
        readings: [...new Set([...(base.readings ?? []), model, id])],
        ...(efforts.length ? { efforts } : {}),
        // Ours, not the server's: the two rows this machine codes on open at
        // `medium` whatever `model/list` states. Older rows keep the server's
        // own default. Moved off `gpt-5.6-sol` 2026-09-23 and off `gpt-6-sol`
        // 2026-09-30, each time with the Older cutoff.
        defaultEffort:
          model === 'gpt-6-astra' || model === 'gpt-6.1-sol'
            ? 'medium'
            : entry.defaultReasoningEffort,
        modalities: entry.inputModalities,
        ...(entry.isDefault ? { isDefault: true } : {})
      });
    }
  }
  if (
    value.nextCursor !== undefined &&
    value.nextCursor !== null &&
    typeof value.nextCursor !== 'string'
  ) {
    return undefined;
  }
  return { models, ...(typeof value.nextCursor === 'string' ? { next: value.nextCursor } : {}) };
}

let held: readonly Model[] = [];
let heldFor: string | undefined;
let accountGeneration = 0;
let refreshGeneration = 0;

export function codexModels(): readonly Model[] {
  return held;
}

/** Account switches retire the previous account's catalog before any fallible read. */
export function noteCodexModelAccount(accountKey: string): void {
  if (heldFor !== undefined && heldFor !== accountKey) {
    held = [];
    accountGeneration += 1;
  }
  heldFor = accountKey;
}

export async function refreshCodexModels(client: CodexRpc): Promise<boolean> {
  const forAccount = heldFor;
  const accountAtStart = accountGeneration;
  const refreshAtStart = ++refreshGeneration;
  const next: Model[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const raw = await client.request('model/list', {
      limit: 100,
      ...(cursor ? { cursor } : {})
    });
    const page = modelPage(raw);
    if (!page) return false;
    next.push(...page.models);
    if (!page.next) {
      if (
        forAccount !== heldFor ||
        accountAtStart !== accountGeneration ||
        refreshAtStart !== refreshGeneration
      ) {
        return false;
      }
      held = next.sort(
        (a, b) =>
          (RANK.get(a.value) ?? Number.MAX_SAFE_INTEGER) -
          (RANK.get(b.value) ?? Number.MAX_SAFE_INTEGER)
      );
      return true;
    }
    if (seen.has(page.next)) return false;
    seen.add(page.next);
    cursor = page.next;
  }
  return false;
}

export function resetCodexModelsForTest(): void {
  held = [];
  heldFor = undefined;
  accountGeneration = 0;
  refreshGeneration = 0;
}

function rowFor(model: string | undefined): Model | undefined {
  if (model) return held.find((row) => row.value === model || row.id === model);
  return held.find((row) => row.isDefault);
}

/** Unknown before the first catalog refresh preserves the protocol's capability. */
export function codexAcceptsImages(model: string | undefined): boolean {
  const row = rowFor(model);
  return row ? row.modalities?.includes('image') === true : true;
}

/** Refuse a known-invalid effort; unknown rows remain the server's decision. */
export function codexEffort(
  model: string | undefined,
  effort: string | undefined
): string | undefined {
  if (!effort) return undefined;
  const row = rowFor(model);
  return row?.efforts && !row.efforts.some((entry) => entry.value === effort) ? undefined : effort;
}
