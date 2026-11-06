import * as fs from 'fs/promises';
import * as path from 'path';
import type { BrandId, Session } from './model';
import { sessionBrand } from './brands';
import { readTree } from './git';
import * as platform from './platform';

export type SkillSource = {
  directory: string;
  format?: 'commands';
  metadata?: 'required';
  nameFrom?: 'metadata';
};
export type SkillProvider = {
  readonly brand: BrandId;
  skillSources(home: string, env: NodeJS.ProcessEnv, cwd?: string): readonly SkillSource[];
};
export type SkillNames = Partial<Record<BrandId, string[]>>;
type SkillFile = {
  file: string;
  fallback: string;
  name?: string;
  description: boolean;
  malformed: boolean;
};
type SkillEntry = { name: string; file: string };
type Entries = Partial<Record<BrandId, readonly SkillEntry[]>>;

/** Window-lived folder snapshot. Physical reads are shared; source membership is not. */
export class SkillDiscovery {
  private scans = new Map<string, Promise<readonly SkillFile[]>>();
  private projects = new Map<string, Promise<Entries>>();
  private readonly global: Promise<void>;
  private globals: Entries = {};
  private workspaces = new Map<string, Entries>();
  private generation = 0;
  private disposed = false;
  private workspaceRead = Promise.resolve();
  private refreshing: Promise<void> | undefined;
  private freshAt = -Infinity;
  private attemptedAt = -Infinity;

  constructor(
    private readonly providers: readonly SkillProvider[],
    private readonly home: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly changed: () => void = () => {}
  ) {
    this.global = this.discover().then((entries) => {
      if (!this.disposed) {
        this.globals = entries;
        this.freshAt = performance.now();
      }
    });
  }

  setWorkspaces(roots: readonly string[]): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const generation = ++this.generation;
    this.workspaceRead = this.readWorkspaces(roots, generation);
    return this.workspaceRead;
  }

  private async readWorkspaces(roots: readonly string[], generation: number): Promise<void> {
    const directories = await Promise.all(roots.map(canonical));
    const entries = await Promise.all(
      directories.map(async (cwd) => {
        let pending = this.projects.get(cwd);
        if (!pending) {
          pending = this.discover(cwd);
          this.projects.set(cwd, pending);
        }
        return [cwd, await pending] as const;
      })
    );
    await this.global;
    if (generation === this.generation) this.workspaces = new Map(entries);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.workspaces.clear();
    this.globals = {};
    this.scans.clear();
    this.projects.clear();
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.refreshIfStale().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshIfStale(): Promise<void> {
    const generation = this.generation;
    await Promise.all([this.global, this.workspaceRead]);
    const now = performance.now();
    if (
      this.disposed ||
      generation !== this.generation ||
      now - Math.max(this.freshAt, this.attemptedAt) < 60_000
    )
      return;
    this.attemptedAt = now;
    const scans = new Map<string, Promise<readonly SkillFile[]>>();
    const projects = new Map(
      [...this.workspaces.keys()].map((cwd) => [cwd, this.discover(cwd, scans)] as const)
    );
    const [globals, workspaces] = await Promise.all([
      this.discover(undefined, scans),
      Promise.all([...projects].map(async ([cwd, entries]) => [cwd, await entries] as const))
    ]);
    if (this.disposed || generation !== this.generation) return;
    this.scans = scans;
    this.projects = projects;
    this.globals = globals;
    this.workspaces = new Map(workspaces);
    this.freshAt = performance.now();
    this.changed();
  }

  async forCwd(cwd: string): Promise<SkillNames> {
    await this.global;
    const directory = await canonical(cwd);
    const root = [...this.workspaces.keys()]
      .filter((candidate) => contains(candidate, directory))
      .sort((a, b) => b.length - a.length)[0];
    return this.names(root ? this.workspaces.get(root) : undefined);
  }

  async forSession(session: Pick<Session, 'cwd' | 'liveCwd' | 'brand'>): Promise<string[]> {
    return (await this.forCwd(session.liveCwd ?? session.cwd))[sessionBrand(session.brand)] ?? [];
  }

  union(): string[] {
    return [
      ...new Set([
        ...Object.values(this.globals)
          .flat()
          .map((entry) => entry.name),
        ...[...this.workspaces.values()].flatMap((entries) =>
          Object.values(entries)
            .flat()
            .map((entry) => entry.name)
        )
      ])
    ].sort();
  }

  /** Every directory's project sources, nearest first, over the globals — for
   *  a caller that knows the chain a CLI reads (`projectDirectories`). */
  async forDirectories(directories: readonly string[]): Promise<SkillNames> {
    const projects = await Promise.all(
      (await Promise.all(directories.map(canonical))).map((cwd) => {
        let pending = this.projects.get(cwd);
        if (!pending) {
          pending = this.discover(cwd);
          this.projects.set(cwd, pending);
        }
        return pending;
      })
    );
    await this.global;
    return this.names(...projects);
  }

  private names(...projects: (Entries | undefined)[]): SkillNames {
    return Object.fromEntries(
      this.providers.map(({ brand }) => {
        const entries = [
          ...projects.flatMap((project) => project?.[brand] ?? []),
          ...(this.globals[brand] ?? [])
        ];
        const names = [...new Set(entries.map((entry) => entry.name))].sort();
        return [brand, names] as const;
      })
    );
  }

  private async discover(cwd?: string, scans = this.scans): Promise<Entries> {
    return Object.fromEntries(
      await Promise.all(
        this.providers.map(async (provider) => {
          const entries: SkillEntry[] = [];
          for (const source of provider.skillSources(this.home, this.env, cwd)) {
            const directory = await canonical(source.directory);
            const key = `${source.format ?? 'skills'}:${directory}`;
            let pending = scans.get(key);
            if (!pending) {
              pending = scanSkills(directory, source.format === 'commands');
              scans.set(key, pending);
            }
            for (const file of await pending) {
              const pathNamed = source.format === 'commands' && source.nameFrom !== 'metadata';
              if (
                (!pathNamed && file.malformed) ||
                (source.metadata === 'required' && (!file.name || !file.description))
              )
                continue;
              entries.push({
                name: pathNamed ? file.fallback : (file.name ?? file.fallback),
                file: file.file
              });
            }
          }
          const named = new Map<string, SkillEntry>();
          const files = new Set<string>();
          for (const entry of entries) {
            if (named.has(entry.name) || files.has(entry.file)) continue;
            named.set(entry.name, entry);
            files.add(entry.file);
          }
          return [provider.brand, [...named.values()]] as const;
        })
      )
    );
  }
}

/**
 * The directories whose project sources a CLI started at `cwd` reads: the cwd
 * and each parent up to its working tree's root, nearest first; the cwd alone
 * outside a repo. Probed 2026-10-18 on all three brands
 * (`TASK_done_workflow_uses_brand_seam.md`, Step 1 evidence). Outside a
 * repo Claude also reads parents, which this leaves out.
 */
export async function projectDirectories(cwd: string): Promise<string[]> {
  const start = await canonical(cwd);
  const root = (await readTree(start))?.treeRoot;
  if (root === undefined || !contains(root, start)) return [start];
  const chain = [start];
  const top = platform.paths.key(root);
  for (let at = start; platform.paths.key(at) !== top;) {
    at = path.dirname(at);
    chain.push(at);
  }
  return chain;
}

async function canonical(directory: string): Promise<string> {
  return fs.realpath(directory).catch(() => path.resolve(directory));
}

function contains(root: string, cwd: string): boolean {
  return platform.paths.contains(path.resolve(root), path.resolve(cwd));
}

async function scanSkills(root: string, commands: boolean): Promise<readonly SkillFile[]> {
  const visited = new Set<string>();
  const result: SkillFile[] = [];
  async function walk(directory: string, depth: number, prefix: string): Promise<void> {
    const real = await canonical(directory);
    if (depth > 8 || visited.has(real)) return;
    visited.add(real);
    if (!commands && depth > 0) {
      const file = await readSkill(path.join(real, 'SKILL.md'), path.basename(real));
      if (file) {
        result.push(file);
        return;
      }
    }
    const children = await fs.readdir(real, { withFileTypes: true }).catch(() => []);
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(real, child.name);
      if (commands && (child.isFile() || child.isSymbolicLink()) && child.name.endsWith('.md')) {
        const read = await readSkill(file, prefix + child.name.slice(0, -3));
        if (read) result.push(read);
      } else if (child.isSymbolicLink()) {
        if (!commands) {
          const linked = await canonical(file);
          const read = await readSkill(path.join(linked, 'SKILL.md'), path.basename(linked));
          if (read) result.push(read);
        }
      } else if (child.isDirectory()) {
        await walk(file, depth + 1, `${prefix}${child.name}:`);
      }
    }
  }
  await walk(root, 0, '');
  return result;
}

async function readSkill(file: string, fallback: string): Promise<SkillFile | undefined> {
  const handle = await fs.open(file, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, '');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    const stated = frontmatter?.match(/^name:[ \t]*(.*)$/m)?.[1];
    const name = stated === undefined ? undefined : scalarValue(stated);
    const description = frontmatter?.match(/^description:[ \t]*(.*)((?:\r?\n[ \t]+.*)*)/m);
    const descriptionValue =
      description?.[1] === undefined ? undefined : scalarValue(description[1]);
    const valid = name !== undefined && /^[\p{L}\p{N}_.:-]+$/u.test(name) && name.length <= 200;
    return {
      file: await fs.realpath(file),
      fallback,
      name: valid ? name : undefined,
      description:
        descriptionValue !== undefined &&
        (/^[>|][1-9+-]*$/.test(descriptionValue)
          ? Boolean(description?.[2]?.trim())
          : descriptionValue.trim().length > 0),
      // An unclosed fence is a body with no metadata: Claude and Grok list it
      // under its folder, Codex lists nothing (probed 2026-10-18,
      // TASK_done_workflow_uses_brand_seam.md).
      malformed: stated !== undefined && !valid
    };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function scalarValue(stated: string): string | undefined {
  const value = stated.trim();
  const quoted = value.startsWith('"')
    ? /^"(?:[^"\\]|\\.)*"/.exec(value)?.[0]
    : value.startsWith("'")
      ? /^'(?:[^']|'')*'/.exec(value)?.[0]
      : undefined;
  if (quoted !== undefined) {
    const rest = value.slice(quoted.length).trim();
    if (rest && !rest.startsWith('#')) return undefined;
    if (quoted.startsWith("'")) return quoted.slice(1, -1).replaceAll("''", "'");
    try {
      const decoded: unknown = JSON.parse(quoted);
      return typeof decoded === 'string' ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith('"') || value.startsWith("'")) return undefined;
  return value.replace(/(?:^|[ \t]+)#.*$/, '').trim();
}
