import * as fs from 'node:fs';
import * as path from 'node:path';

/** Seed and live HOME are supervisor-owned canonical directories. Never follow
 *  a scenario's links while deleting additions or looking for drift. */
export function restore(seed: string, home: string, excluded: readonly string[]): void {
  roots(seed, home);
  visit(
    seed,
    home,
    excluded,
    (rel, source, target, protectedParent) => {
      const from = path.join(seed, rel);
      const to = path.join(home, rel);
      if (
        protectedParent &&
        ((source && !source.isDirectory()) || (target && !target.isDirectory()))
      )
        throw new Error(`seed restore cannot replace ancestor of host-owned path: ${to}`);
      if (!source) {
        if (target) {
          if (!protectedParent) remove(to, target);
          else fs.chmodSync(to, target.mode | 0o700);
        }
        return protectedParent;
      }
      if (source.isDirectory()) {
        if (target && !target.isDirectory()) remove(to, target);
        fs.mkdirSync(to, { recursive: true });
        fs.chmodSync(to, source.mode | 0o700);
        return true;
      }
      if (target) remove(to, target);
      if (source.isSymbolicLink()) {
        fs.symlinkSync(fs.readlinkSync(from), to);
        fs.lutimesSync(to, source.atime, source.mtime);
      } else fs.cpSync(from, to, { preserveTimestamps: true });
      return false;
    },
    (rel, source, target, protectedParent) => {
      const directory = source?.isDirectory()
        ? source
        : protectedParent && target?.isDirectory()
          ? target
          : undefined;
      if (!directory) return;
      const to = path.join(home, rel);
      fs.chmodSync(to, directory.mode);
      fs.utimesSync(to, directory.atime, directory.mtime);
    }
  );
}

/** rsync's file quick check: diagnostic drift, not a content hash or reset gate. */
export function drift(seed: string, home: string, excluded: readonly string[]): string[] {
  roots(seed, home);
  const changed: string[] = [];
  visit(seed, home, excluded, (rel, source, target) => {
    if (
      (source?.isFile() || target?.isFile()) &&
      (!source?.isFile() ||
        !target?.isFile() ||
        source.size !== target.size ||
        Math.trunc(source.mtimeMs / 1000) !== Math.trunc(target.mtimeMs / 1000) ||
        (source.mode & 0o7777) !== (target.mode & 0o7777))
    )
      changed.push(rel);
    return !!(source?.isDirectory() || target?.isDirectory());
  });
  return changed;
}

function roots(seed: string, home: string): void {
  for (const root of [seed, home]) {
    if (!path.isAbsolute(root) || !fs.lstatSync(root).isDirectory())
      throw new Error(`seed operation requires a real absolute directory: ${root}`);
  }
  const from = fs.realpathSync(seed);
  const to = fs.realpathSync(home);
  for (const rel of [path.relative(from, to), path.relative(to, from)]) {
    if (!rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)))
      throw new Error('seed and HOME must be separate trees');
  }
}

function stat(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function visit(
  seed: string,
  home: string,
  excluded: readonly string[],
  entry: (
    rel: string,
    source: fs.Stats | undefined,
    target: fs.Stats | undefined,
    protectedParent: boolean
  ) => boolean,
  after?: (
    rel: string,
    source: fs.Stats | undefined,
    target: fs.Stats | undefined,
    protectedParent: boolean
  ) => void
): void {
  const walk = (rel: string, source: fs.Stats | undefined, target: fs.Stats | undefined): void => {
    if (excluded.some((name) => rel === name || rel.startsWith(`${name}/`))) return;
    const protectedParent = excluded.some((name) => !rel || name.startsWith(`${rel}/`));
    if (entry(rel, source, target, protectedParent)) {
      const names = new Set([
        ...(source?.isDirectory() ? fs.readdirSync(path.join(seed, rel)) : []),
        ...(target?.isDirectory() ? fs.readdirSync(path.join(home, rel)) : [])
      ]);
      for (const name of names) {
        const child = rel ? `${rel}/${name}` : name;
        walk(
          child,
          source?.isDirectory() ? stat(path.join(seed, child)) : undefined,
          target?.isDirectory() ? stat(path.join(home, child)) : undefined
        );
      }
    }
    after?.(rel, source, target, protectedParent);
  };
  walk('', fs.lstatSync(seed), fs.lstatSync(home));
}

function remove(file: string, entry: fs.Stats): void {
  if (!entry.isDirectory()) {
    fs.unlinkSync(file);
    return;
  }
  fs.chmodSync(file, entry.mode | 0o700);
  for (const name of fs.readdirSync(file)) {
    const child = path.join(file, name);
    remove(child, fs.lstatSync(child));
  }
  fs.rmdirSync(file);
}
