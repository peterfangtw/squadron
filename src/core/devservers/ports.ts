import { createHash } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import { readJson, writeAtomicJson } from '../files';
import { PORTS_DIR } from '../paths';
import * as platform from '../platform';

/**
 * Numbers: which ports in a repo's block are taken, and whether a server that
 * was asked for one ever answered on it.
 *
 * The panel allocates nothing. It reports occupancy and the user chooses — so
 * everything here is a reading, and none of it confers a right to a port.
 *
 * `net` is stdlib, and nothing else in `src/` opens a socket, so this module has
 * no analog to extend.
 */

/** One port in a repo's block, as the picker draws it. */
export type PortStatus = {
  port: number;
  free: boolean;
  /** The branch whose server has this port, when a registry entry claims it. */
  heldBy?: string;
};

/** The contiguous range a repo's servers are picked from. */
export type PortBlock = { base: number; span: number };

/**
 * Whether a port can be listened on — **four addresses, and that is the point.**
 *
 * Measured 2026-07-26 against Vite 7.3.1: a live dev server binds `[::1]` and
 * nothing else, and every single-family test says the port is free:
 *
 * ```
 * listen(4322)            -> FREE     # the naive test
 * listen(4322, 127.0.0.1) -> FREE
 * listen(4322, 0.0.0.0)   -> FREE
 * listen(4322, ::1)       -> EADDRINUSE
 * ```
 *
 * So a one-family check offers one worktree's live port to the next.
 *
 * **And the mirror case, measured 2026-08-04, which the loopback pair alone
 * does not catch.** A server on a wildcard address — `0.0.0.0` or `::`, which
 * is what a default `listen(port)` and any `--host` does — leaves both loopback
 * binds *succeeding* on macOS, because a specific address may be bound under a
 * wildcard one:
 *
 * ```
 * # with a listener on 0.0.0.0:P          # with a listener on ::1:P
 * listen(P, ::1)       -> FREE            listen(P, ::1)       -> EADDRINUSE
 * listen(P, 127.0.0.1) -> FREE            listen(P, 127.0.0.1) -> FREE
 * listen(P)            -> FREE            listen(P)            -> FREE
 * listen(P, 0.0.0.0)   -> EADDRINUSE      listen(P, 0.0.0.0)   -> FREE
 * ```
 *
 * Note the third row: node's default bind is `::`, and macOS lets it succeed
 * under an IPv4 wildcard listener — so "the default plus the loopbacks" is not
 * enough either. It takes all four.
 *
 * The two columns are caught by different binds and neither catches both, so
 * the test is all four. Found by a smoke test whose fake server was made to
 * listen on the wrong port on purpose: the panel offered a port another
 * project's Vite was serving on, probed it, got an answer, and drew a green
 * chip reading `localhost:3000` for a server that was not ours — the one thing
 * this feature exists to never do.
 *
 * Every host is bound, every one is closed, and any of them failing makes the
 * port unfree.
 */
export async function free(port: number): Promise<boolean> {
  // Four, and each is load-bearing: the two loopbacks catch a server that bound
  // only one family, and the two wildcards catch one that bound neither
  // specifically. `0.0.0.0` is not covered by the default bind — node's default
  // is `::`, and macOS lets that succeed while an IPv4 wildcard listener holds
  // the port, which is the case measured 2026-08-04.
  for (const host of ['::1', '127.0.0.1', '0.0.0.0', '::']) {
    if (!(await bindable(port, host))) {
      return false;
    }
  }
  return true;
}

/** One listen-then-close. A host this machine has no stack for is not a claim. */
function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      // `EAFNOSUPPORT`/`EADDRNOTAVAIL`: no IPv6 on this machine, say. Nothing is
      // listening there either, so it cannot be what makes a port unfree.
      resolve(error.code !== 'EADDRINUSE');
    });
    server.once('listening', () => server.close(() => resolve(true)));
    try {
      server.listen(port, host);
    } catch {
      // A port outside 0–65535 makes `listen` throw here rather than emit
      // `error`, and a throw inside this executor rejects a promise every
      // caller up to `openRunPicker` treats as one that only ever resolves.
      // `readPorts` and `resolveBlock` already refuse such a block; this is
      // the second lock.
      resolve(false);
    }
  });
}

/**
 * Every port in the block, with what is on it — bind-tested in parallel, since
 * a block is ten ports and each is a syscall pair.
 *
 * `claimed` names the branch whose registry entry says it took a port. A
 * reservation that is not yet bound still shows a holder, which is what stops
 * two windows picking the same port in the seconds before either server is up.
 */
export function occupancy(
  block: PortBlock,
  claimed: ReadonlyMap<number, string> = new Map()
): Promise<PortStatus[]> {
  return occupancyOf(
    Array.from({ length: block.span }, (_, i) => block.base + i),
    claimed
  );
}

/**
 * `occupancy` over any set of ports. **Each must appear once**: two `free`
 * calls on one port at the same time each read the other's probe listener as
 * a holder — measured 2026-11-03, blocks 40120+10 and 40125+10 bound side by
 * side reported 40125–40129 held on 10 passes of 10 with nothing listening.
 */
export async function occupancyOf(
  ports: readonly number[],
  claimed: ReadonlyMap<number, string> = new Map()
): Promise<PortStatus[]> {
  return Promise.all(
    ports.map(async (port) => {
      const held = claimed.get(port);
      const open = await free(port);
      return {
        port,
        free: open && held === undefined,
        ...(held !== undefined ? { heldBy: held } : {})
      };
    })
  );
}

/**
 * Every distinct port a servers sheet's answer covers, in port order: each
 * start's block — they overlap, a next app's derived block being
 * `DEFAULT_BLOCK` and a hand-set one need not avoid a toolchain's — plus each
 * start's remembered port, so the sheet can offer it back when it lies outside
 * that start's block. Which start it is outside of is the webview's to say.
 * A start with no block takes no port and offers nothing back.
 */
export function sheetPorts(
  starts: readonly { key: string; block?: PortBlock }[],
  lastUsed: { readonly [key: string]: number }
): number[] {
  const ports = new Set<number>();
  for (const { key, block } of starts) {
    if (!block) continue;
    for (let port = block.base; port < block.base + block.span; port++) ports.add(port);
    const last = lastUsed[key];
    // `lastUsed` is a hand-editable file: a number `bindable` cannot listen on
    // is skipped, for the reason `usable` exists.
    if (last !== undefined && usable({ base: last, span: 1 })) ports.add(last);
  }
  return [...ports].sort((a, b) => a - b);
}

/** How long a readiness connect waits before calling a port silent. */
const PROBE_TIMEOUT_MS = 500;

/**
 * Whether something is answering on a port, asked of **`localhost`** so the
 * resolver tries both families.
 *
 * The other half of the same 2026-07-26 measurement: with Vite live on
 * `[::1]:4322`, `net.connect('127.0.0.1', 4322)` is `ECONNREFUSED` — a healthy
 * server looks dead — while `localhost` connects. A `127.0.0.1` probe would
 * leave a running server on `starting` forever.
 */
export function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });
    const settle = (answered: boolean) => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/**
 * What a repo's ports look like between runs: the block a reader set for it, if
 * any, and the port each branch chose last time, per runner.
 *
 * **This confers nothing** (A17). A remembered port is a default in a picker,
 * greyed out like any other if something else took it in the meantime — there is
 * no reservation here to reconcile and no conflict state to draw.
 *
 * `block` is an override, and only ever hand-written: absent, each start's
 * block is derived from its toolchain (`resolveBlock`). It is in this file
 * rather than in settings (Q7) because it is per repo — present, it is every
 * start's block — and right beside the picks it governs. `repoRoot` is stored as well as hashed into the name, for the reason
 * `arrange.ts` gives — a collision is then detectable rather than silent.
 */
export type RepoPorts = {
  schema: 1;
  repoRoot: string;
  /** Present only when the file carried a usable one that is not `DEFAULT_BLOCK`. */
  block?: PortBlock;
  /**
   * branch -> `rememberKey` -> the port it picked last.
   *
   * The inner key is a runner id at the tree root and `<rel>:<runnerId>` for a
   * workspace package below it, because one monorepo branch can run several
   * apps and every one of their scripts is called `dev`.
   */
  lastUsed: { [branch: string]: { [key: string]: number } };
};

/**
 * How a start is remembered: the runner alone at the tree root, and the
 * tree-relative directory before it otherwise.
 *
 * One body, because two callers compose it — the write after a boot and the read
 * when the sheet opens — and a key those two spell differently is a remembered
 * port that can be written and never found again.
 *
 * `runnerId` is deliberately not namespaced anywhere else: `detectRunner`, the
 * settings `commands` map and `servers.ts` all key on `cwd`, which already tells
 * two apps apart. This is the one boundary that does not have it.
 *
 * **No migration.** An old bare-`dev` entry keeps working for a root runner and
 * is simply not found for an app — a default in a picker, which A17 already says
 * confers nothing.
 *
 * Composed from both path keys, never the raw spellings: it is a store key, and
 * one directory spelled two ways must still find its port.
 */
export function rememberKey(tree: string, cwd: string, runnerId: string): string {
  const root = path.resolve(tree);
  const dir = path.resolve(cwd);
  // A `cwd` outside its own tree is not something this can key; fall back to the
  // bare runner rather than writing `../..` into the store.
  if (!platform.paths.contains(root, dir)) return runnerId;
  const rel = path.relative(platform.paths.key(root), platform.paths.key(dir));
  return rel ? rel.split(path.sep).join('/') + ':' + runnerId : runnerId;
}

/** Where a start with no known toolchain starts from: ten ports above 3000,
 *  the dev-server convention. */
export const DEFAULT_BLOCK: PortBlock = { base: 3000, span: 10 };

/** How many ports a derived block offers, from the toolchain's own port up. */
const DERIVED_SPAN = 10;

/**
 * The block one start is offered: the file's override, else ten ports from the
 * toolchain's own port, else `DEFAULT_BLOCK`. `suggest` is typed a number but
 * can be a settings-named runner's arbitrary JSON, so `usable()`'s integer
 * check is what keeps a bad one from hanging `occupancy`.
 */
export function resolveBlock(ports: RepoPorts, suggest?: number): PortBlock {
  if (ports.block) return ports.block;
  const derived = { base: suggest as number, span: DERIVED_SPAN };
  return usable(derived) ? derived : DEFAULT_BLOCK;
}

/**
 * Every ports file that ever remembered a pick before the block was derived
 * carries `DEFAULT_BLOCK`, written by `rememberPort` rather than by anyone, so
 * that exact value reads as unset. A reader who hand-set 3000–3009 loses it,
 * and gets 3000–3009 for any start without a known toolchain anyway.
 */
const isMinted = (block: PortBlock): boolean =>
  block.base === DEFAULT_BLOCK.base && block.span === DEFAULT_BLOCK.span;

/** Hashed like `arrange.ts`: a path has slashes in it and can be arbitrarily deep. */
function fileFor(repoRoot: string): string {
  return path.join(
    PORTS_DIR,
    createHash('sha256').update(platform.paths.key(repoRoot)).digest('hex').slice(0, 16) + '.json'
  );
}

/**
 * The most ports a block may span. `occupancy` binds every one of them four
 * times on every picker open, so a hand-edit of `span` is a hand-edit of how
 * much work that click is — and `Array.from({length: span})` would take the machine down
 * long before it took the panel down.
 */
const MAX_SPAN = 64;

/**
 * Whether a block can actually be bound. **A type check is not enough here:**
 * `net.listen` throws synchronously outside 0–65535, past the `error` handler
 * `bindable` resolves on, so an unusable block does not degrade a picker — it
 * hangs one, on every open, with nothing said. `1024` because a block below it
 * is ports this cannot bind unprivileged anyway.
 */
export function usable(block: PortBlock | undefined): block is PortBlock {
  return (
    !!block &&
    Number.isInteger(block.base) &&
    Number.isInteger(block.span) &&
    block.span > 0 &&
    block.span <= MAX_SPAN &&
    block.base >= 1024 &&
    block.base + block.span <= 65536
  );
}

/**
 * A repo's block and its remembered picks. A missing file is a repo nobody has
 * started a server in; a malformed one is treated the same, since the worst it
 * can cost is a picker opening on the default block.
 *
 * A foreign `schema`, or another repo's record behind a hash collision, is
 * refused whole rather than read field by field — the check `arrange.ts` makes
 * for the same reason, and what makes the collision this file's name risks
 * detectable instead of silent.
 */
export async function readPorts(repoRoot: string): Promise<RepoPorts> {
  const raw = await readJson<RepoPorts>(fileFor(repoRoot));
  const mine =
    raw?.schema === 1 &&
    typeof raw.repoRoot === 'string' &&
    platform.paths.key(raw.repoRoot) === platform.paths.key(repoRoot)
      ? raw
      : undefined;
  const block = mine?.block;
  return {
    schema: 1,
    repoRoot,
    ...(usable(block) && !isMinted(block) ? { block } : {}),
    // The hand-editable half is honoured field by field, so a broken `lastUsed`
    // does not also cost the reader the block they set.
    lastUsed: mine?.lastUsed && typeof mine.lastUsed === 'object' ? mine.lastUsed : {}
  };
}

/**
 * Writes down what a branch just picked, and a `block` only when one was read —
 * a pick is not a decision about the block. Read-modify-write, last write wins —
 * the same shrug `arrange.ts` documents, and here it costs one branch one
 * remembered default rather than anything a person would notice.
 *
 * No sweep. A branch that is gone is one line in a ten-line file, and forgetting
 * it would mean asking git about branches on a path only this file remembers.
 */
export async function rememberPort(
  repoRoot: string,
  branch: string,
  key: string,
  port: number
): Promise<void> {
  const current = await readPorts(repoRoot);
  const record: RepoPorts = {
    ...current,
    lastUsed: { ...current.lastUsed, [branch]: { ...current.lastUsed[branch], [key]: port } }
  };
  await writeAtomicJson(fileFor(repoRoot), record);
}
