import * as path from 'path';
import { isBrand } from './brands';
import { conversationKey } from './identity';
import { readJsonDir, writeAtomicJson } from './files';
import type { BrandId } from './model';
import { WARM_DIR } from './paths';

export type WarmChoice = {
  schema: 1;
  brand: BrandId;
  sessionId: string;
  on: boolean;
  statedAt: number;
};

export function effectiveWarm(
  choice: Pick<WarmChoice, 'on'> | undefined,
  enabled: boolean
): boolean {
  return choice?.on ?? enabled;
}

function validKey(brand: unknown, sessionId: unknown): boolean {
  return isBrand(brand) && typeof sessionId === 'string' && /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

export function writeWarmChoice(
  brand: BrandId,
  sessionId: string,
  on: boolean,
  at: number
): Promise<boolean> {
  if (!validKey(brand, sessionId) || typeof on !== 'boolean' || !Number.isFinite(at))
    return Promise.resolve(false);
  return writeAtomicJson(
    path.join(WARM_DIR, `${brand}.${sessionId}.json`),
    {
      schema: 1,
      brand,
      sessionId,
      on,
      statedAt: at
    } satisfies WarmChoice,
    'state'
  );
}

/** One atomic file per conversation prevents two windows losing unrelated choices.
 *  Never swept: a resume must retain explicit off as well as on. */
export async function readWarmChoices(): Promise<Map<string, WarmChoice>> {
  const found = await readJsonDir(WARM_DIR, (raw, file) => {
    const choice = raw as Partial<WarmChoice> | undefined;
    if (
      choice?.schema !== 1 ||
      !validKey(choice.brand, choice.sessionId) ||
      typeof choice.on !== 'boolean' ||
      typeof choice.statedAt !== 'number' ||
      !Number.isFinite(choice.statedAt)
    )
      return undefined;
    const stated = choice as WarmChoice;
    return path.basename(file, '.json') === `${stated.brand}.${stated.sessionId}`
      ? ([conversationKey(stated.brand, stated.sessionId), stated] as const)
      : undefined;
  });
  return new Map(found);
}
