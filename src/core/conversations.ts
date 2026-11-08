/** Past conversations indexed from the transcript store Squadron writes. */

import * as fs from 'fs/promises';
import * as path from 'path';
import { readCheckout, readWorktrees, type HeadPass, type Worktree } from './git';
import type { BrandId } from './model';
import * as platform from './platform';
import * as catalog from './conversation_catalog';

export type Conversation = {
  sessionId: string;
  title: string;
  /** False when `title` is a prompt standing in, so a row can say so. */
  titled: boolean;
  lastActivity: number;
  branch?: string;
  /** Where this conversation must be resumed — not always the asked folder. */
  cwd: string;
  brand: BrandId;
};

function contains(root: string, cwd: string): boolean {
  return platform.paths.contains(path.resolve(root), path.resolve(cwd));
}

function checkoutFor(cwd: string, trees: readonly Worktree[]): Worktree | undefined {
  return trees
    .filter((tree) => contains(tree.path, cwd))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

type Family = { repoRoot?: string; trees: Worktree[] };

async function family(cwd: string): Promise<Family> {
  const checkout = await readCheckout(cwd);
  if (!checkout) return { trees: [{ path: cwd }] };
  const trees = await readWorktrees(checkout.repoRoot);
  return {
    repoRoot: checkout.repoRoot,
    trees: trees.length ? trees : [{ path: checkout.repoRoot, branch: checkout.branch, main: true }]
  };
}

/** Whether a recorded cwd is in this family, and under which checkout. Each
 *  distinct cwd pays one `.git` read per call site, however many records name it. */
function familyMember(scope: Family): (cwd: string) => Promise<Worktree | undefined> {
  const heads: HeadPass = new Map();
  const memberships = new Map<string, Promise<boolean>>();
  return async (cwd) => {
    const tree = checkoutFor(cwd, scope.trees);
    if (!tree) return undefined;
    let membership = memberships.get(cwd);
    if (!membership) {
      membership = belongsToFamily(cwd, scope.repoRoot, heads);
      memberships.set(cwd, membership);
    }
    return (await membership) ? tree : undefined;
  };
}

async function belongsToFamily(
  cwd: string,
  repoRoot: string | undefined,
  heads: HeadPass
): Promise<boolean> {
  const checkout = await readCheckout(cwd, heads);
  if (repoRoot !== undefined)
    return (
      checkout !== undefined &&
      platform.paths.key(checkout.repoRoot) === platform.paths.key(repoRoot)
    );
  if (checkout) return false;
  try {
    return (await fs.stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}

/** Newest first, asked-cwd floor, then a single page cut. */
export function mergeConversations(
  rows: readonly Conversation[],
  cwd: string,
  cap = 20
): Conversation[] {
  const settled = [...rows].sort((a, b) => b.lastActivity - a.lastActivity);
  const floor = Math.ceil(cap / 2);
  const asked = platform.paths.key(cwd);
  const here = (row: Conversation) => platform.paths.key(row.cwd) === asked;
  const mine = settled.filter(here);
  const top = settled.slice(0, cap);
  const want = Math.min(floor, mine.length);
  const has = top.filter(here).length;
  if (has >= want) return top;
  const missing = mine.slice(has, want);
  const others = top.filter((row) => !here(row));
  const displaced = new Set(others.slice(others.length - missing.length));
  return [...top.filter((row) => !displaced.has(row)), ...missing].sort(
    (a, b) => b.lastActivity - a.lastActivity
  );
}

export type ConversationRead = {
  /** Every row of the asked family in the window, newest first. */
  rows: Conversation[];
  current(): boolean;
  /** Publishes what the read learned. Called once the reply is posted. */
  maintain(): Promise<void>;
};

/** Holds only overlapping work; a completed read leaves no resident catalog. */
export class ConversationReader {
  private generation = 0;
  private disposed = false;
  /** A first catalog's publication. The next read waits for it rather than
   *  discovering every header again. */
  private building?: Promise<void>;
  private publishing?: Promise<void>;

  /**
   * The asked repository family's rows in the 30-day window, newest first.
   *
   * Every family record is summarised or validated, so a caller ranks the
   * whole family by recorded activity and never by a file's mtime. With no
   * catalog, every record's header is read first, and the catalog that builds
   * is published after the reply (`maintain`).
   */
  async read(cwd: string, now = Date.now()): Promise<ConversationRead> {
    await this.building;
    const generation = ++this.generation;
    const current = (): boolean => this.current(generation);
    if (!current() || !cwd) return this.prepared([], current);
    const names = await catalog.recordNames();
    if (!names || !current()) return this.prepared([], current);
    const cached = await catalog.readCatalog();
    const entries = cached ?? (await discover(names, current));
    if (!current()) return this.prepared([], current);
    const read = await readFamily(entries, names, cwd, now, current);
    if (!cached) return this.prepared(read.rows, current, () => this.build(generation, entries));
    return this.prepared(
      read.rows,
      current,
      read.dirty ? () => this.publish(generation, entries) : undefined
    );
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
  }

  private prepared(
    rows: Conversation[],
    current: () => boolean,
    run?: () => Promise<void>
  ): ConversationRead {
    let maintained: Promise<void> | undefined;
    return {
      rows,
      current,
      maintain: () =>
        (maintained ??= (current() && run ? run() : Promise.resolve()).catch(() => {}))
    };
  }

  private async build(generation: number, entries: catalog.Catalog): Promise<void> {
    const building = this.publish(generation, entries).catch(() => {});
    this.building = building;
    try {
      await building;
    } finally {
      if (this.building === building) this.building = undefined;
    }
  }

  private async publish(generation: number, entries: catalog.Catalog): Promise<void> {
    const previous = this.publishing;
    const publishing = (async (): Promise<void> => {
      await previous?.catch(() => {});
      if (this.current(generation))
        await catalog.writeCatalog(entries, () => this.current(generation));
    })();
    this.publishing = publishing;
    try {
      await publishing;
    } finally {
      if (this.publishing === publishing) this.publishing = undefined;
    }
  }

  private current(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }
}

/** Every record's header, for a first catalog: eight bounded reads at a time. */
async function discover(
  names: readonly string[],
  current: () => boolean
): Promise<catalog.Catalog> {
  const buffers = Array.from({ length: 8 }, () => Buffer.alloc(4096));
  const headers = await catalog.mapRecords(names, async (name, worker) =>
    current() ? catalog.readHeader(name, buffers[worker]) : undefined
  );
  const entries: catalog.Catalog = new Map();
  for (const read of headers)
    if (read?.stable && catalog.cacheable(read.entry)) entries.set(read.entry.f, read.entry);
  return entries;
}

/**
 * Every row of the asked family in the window, validating `entries` in place.
 *
 * Each family record is checked against its witness and summarised when it has
 * no stable summary; records outside the family are skipped before any stat.
 * `dirty` says whether `entries` now differs from what was read, so an unchanged
 * open writes nothing.
 */
async function readFamily(
  entries: catalog.Catalog,
  names: readonly string[],
  cwd: string,
  now: number,
  current: () => boolean
): Promise<{ rows: Conversation[]; dirty: boolean }> {
  const present = new Set(names);
  const originals = new Map<string, catalog.Entry | undefined>();
  const remember = (name: string): void => {
    if (!originals.has(name)) originals.set(name, entries.get(name));
  };
  for (const [name, entry] of entries) {
    if (!present.has(name)) {
      remember(name);
      entries.delete(name);
      continue;
    }
    if (
      entry.summary?.title &&
      entry.summary.at !== undefined &&
      entry.summary.at < now - catalog.WINDOW_MS
    ) {
      remember(name);
      entries.set(name, { ...entry, summary: { at: entry.summary.at, aged: true } });
    }
  }
  const retain = (entry: catalog.Entry): void => {
    const old = entries.get(entry.f);
    if (old === entry) return;
    if (catalog.cacheable(entry)) {
      if (JSON.stringify(old) !== JSON.stringify(entry)) {
        remember(entry.f);
        entries.set(entry.f, entry);
      }
    } else if (old) {
      remember(entry.f);
      entries.delete(entry.f);
    }
  };
  const scope = await family(cwd);
  const matching = new Map<string, boolean>();
  const buffers = Array.from({ length: 8 }, () => Buffer.alloc(4096));
  const inspected = await catalog.mapRecords(names, async (name, worker) => {
    if (!current()) return undefined;
    const old = entries.get(name);
    if (old?.cwd) {
      let belongs = matching.get(old.cwd);
      if (belongs === undefined) {
        belongs = checkoutFor(old.cwd, scope.trees) !== undefined;
        matching.set(old.cwd, belongs);
      }
      if (!belongs) return undefined;
    }
    const witness = old ? await catalog.currentStamp(name) : undefined;
    if (old && witness && catalog.sameStamp(old.stamp, witness)) return old;
    // A moving record is listed from what was read, and cached once it is still.
    const read = await catalog.readHeader(name, buffers[worker]);
    if (read?.stable) retain(read.entry);
    return read?.entry;
  });
  const member = familyMember(scope);
  const members: { entry: catalog.Entry; cwd: string; brand: BrandId; tree: Worktree }[] = [];
  for (const entry of inspected) {
    if (!entry?.cwd || !entry.brand) continue;
    const tree = await member(entry.cwd);
    if (tree) members.push({ entry, cwd: entry.cwd, brand: entry.brand, tree });
  }
  const summaryBuffers: (catalog.SummaryBuffers | undefined)[] = [];
  const rows = await catalog.mapRecords(
    members,
    async ({ entry, cwd, brand, tree }, worker): Promise<Conversation | undefined> => {
      if (!current()) return undefined;
      const needsTitle =
        entry.summary?.aged &&
        entry.summary.at !== undefined &&
        entry.summary.at >= now - catalog.WINDOW_MS;
      let full = entry;
      if (!entry.summary || needsTitle) {
        const read = await catalog.readSummary(
          entry,
          now,
          (summaryBuffers[worker] ??= catalog.summaryBuffers())
        );
        if (!read) return undefined;
        if (read.stable) retain(read.entry);
        full = read.entry;
      }
      const summary = full.summary;
      if (summary?.at === undefined || summary.at < now - catalog.WINDOW_MS || !summary.title)
        return undefined;
      return {
        sessionId: entry.f.slice(0, -6),
        title: summary.title,
        titled: false,
        lastActivity: summary.at,
        cwd,
        brand,
        ...(tree.branch ? { branch: tree.branch } : {})
      };
    }
  );
  let dirty = false;
  for (const [name, original] of originals) {
    if (JSON.stringify(original) !== JSON.stringify(entries.get(name))) {
      dirty = true;
      break;
    }
  }
  return {
    rows: rows.filter((row) => row !== undefined).sort((a, b) => b.lastActivity - a.lastActivity),
    dirty
  };
}
