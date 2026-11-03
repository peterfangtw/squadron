/**
 * Where the reader put the workflows.
 *
 * `workflows.ts` is the *authored* half — what somebody wrote into a file, and
 * whether it can be run where they are pointing it. This is the other half: a
 * position, which is not a fact about the workflow, and keeping the two apart
 * is what stops an agent rewriting a definition from also moving it in the
 * list.
 *
 * One file, machine-global, beside `workflows/` and never inside it — that
 * directory is the user's and is read by `readJsonDir`, which would take this
 * for a definition and skip it as invalid.
 *
 * **Forgetting is free**, which is `arrange.ts`'s property and the reason this
 * store keeps no back-references. An id here that names no workflow on disk
 * resolves to nothing: no row, no error. It lingers in the file until
 * the next write drops it, and nothing goes wrong in the meantime.
 *
 * Last write wins, no lock. Two windows reordering in the same tick is one of
 * them losing and finding out on the next poll — `arrange.ts` makes the same
 * bargain and writes it down at length. One list is the whole blast radius.
 */

import { readJson, writeAtomicJson } from '../files';
import { WORKFLOW_ORDER_FILE } from '../paths';

/**
 * What the reader has stated. An empty order means they have said nothing —
 * which is the machine that has never dragged.
 *
 * `updatedAt` is stamped and **read by nothing**, here or in `arrange.ts` which
 * stamps one too. It is for the person who opens the file, and is written down
 * as such so the next reader does not go looking for what spends it.
 */
export type WorkflowOrder = {
  schema: 1;
  updatedAt: number;
  /** Only what has been *moved*. An order that materialised every id on the
   *  first drag would have to be maintained on every workflow added, and the
   *  append rule below would become an insert nobody asked for. */
  order: string[];
};

/** What a caller may state. `schema` and `updatedAt` are this module's to write. */
export type StatedOrder = Omit<WorkflowOrder, 'schema' | 'updatedAt'>;

/**
 * The reader's record, or nothing when there is not one to read.
 *
 * Narrowed field by field rather than cast, the way `readArrangements` narrows a
 * slot: this is a file a person may have edited, and a `order` that is a string
 * rather than an array would otherwise reach `includes` and throw on the poll.
 * A field of the wrong type degrades to its absent form — the reader has stated
 * nothing about *that*, which is exactly true.
 */
export async function readWorkflowOrder(): Promise<WorkflowOrder | undefined> {
  const raw = await readJson<unknown>(WORKFLOW_ORDER_FILE);
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const stated = raw as Partial<Record<keyof WorkflowOrder, unknown>>;
  if (stated.schema !== 1) {
    return undefined;
  }
  // `dropDefault` and `pinned` on an older file are ignored. The next write
  // replaces the file, so the keys leave with it. There is no migration.
  return {
    schema: 1,
    updatedAt: typeof stated.updatedAt === 'number' ? stated.updatedAt : 0,
    order: ids(stated.order)
  };
}

/** The strings in something that was supposed to be an array of them, deduped.
 *  Anything else — a number, a null, a nested object — is dropped rather than
 *  coerced: an id is what a filename is made of, and `String(null)` is a file. */
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item !== '' && !kept.includes(item)) {
      kept.push(item);
    }
  }
  return kept;
}

/**
 * Records what the reader has stated. Best effort: a machine that cannot write
 * this still has a panel, drawing the order it derives.
 */
export async function writeWorkflowOrder(stated: StatedOrder): Promise<boolean> {
  const record: WorkflowOrder = {
    schema: 1,
    updatedAt: Date.now(),
    order: ids(stated.order)
  };
  return writeAtomicJson(WORKFLOW_ORDER_FILE, record, 'state');
}

/** The least a thing needs to be to have a place in this list. */
type Placeable = { id: string; label: string };

/**
 * The list in the reader's order: what they have stated first, in the order they
 * stated it, and everything else after it by label.
 *
 * **Label order is the floor**, not a fallback nobody sees. A machine with no
 * file gets the whole list sorted by name, which is already better than the
 * `readdir` order every surface painted before this existed.
 *
 * **A newcomer appends; it does not sort into the stated part.** A workflow that
 * appears while the panel is open — an agent wrote one, the reader saved one —
 * lands under everything they have arranged. Sorting it in would move rows they
 * placed, which is the one thing an order they stated must never do. Among the
 * newcomers themselves label order keeps the tail predictable.
 *
 * Ids in the record that name nothing on disk are skipped, leaving no gap: the
 * reader deleted that workflow, and a hole where it used to be would be the
 * store remembering something it was asked to forget.
 */
export function orderWorkflows<T extends Placeable>(
  list: readonly T[],
  record: WorkflowOrder | undefined
): T[] {
  const byId = new Map(list.map((item) => [item.id, item]));
  const placed: T[] = [];
  const seen = new Set<string>();
  for (const id of record?.order ?? []) {
    const item = byId.get(id);
    if (item !== undefined && !seen.has(id)) {
      placed.push(item);
      seen.add(id);
    }
  }
  const newcomers = list
    .filter((item) => !seen.has(item.id))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...placed, ...newcomers];
}
