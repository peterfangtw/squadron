import * as fs from 'fs/promises';
import * as path from 'path';
import * as platform from './platform';
import type { PathKey } from './platform/paths';

type Watch = { dispose(): void };

export class StateDirectoryWatches {
  private readonly watches = new Map<PathKey, Watch>();
  private updates = Promise.resolve();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly ports: { watch(directory: string): Watch; changed(): void }
  ) {}

  async start(): Promise<void> {
    if (this.closed) return;
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) await this.update(path.join(this.root, entry.name), false);
    }
  }

  notice(directory: string): Promise<void> {
    return this.update(directory, true);
  }

  dispose(): void {
    this.closed = true;
    for (const watch of this.watches.values()) watch.dispose();
    this.watches.clear();
  }

  private update(directory: string, announce: boolean): Promise<void> {
    if (!watchesStateDirectory(this.root, directory)) return Promise.resolve();
    // Serialize discovery and root events; a pending stat cannot resurrect a disposed watch.
    this.updates = this.updates
      .then(async () => {
        if (this.closed) return;
        const info = await fs.lstat(directory).catch(() => undefined);
        if (this.closed) return;
        const key = platform.paths.key(directory);
        const held = this.watches.get(key);
        if (info?.isDirectory()) {
          if (held) return;
          this.watches.set(key, this.ports.watch(directory));
        } else {
          if (!held) return;
          held.dispose();
          this.watches.delete(key);
        }
        if (announce) this.ports.changed();
      })
      .catch(() => {});
    return this.updates;
  }
}

function watchesStateDirectory(stateRoot: string, directory: string): boolean {
  return (
    platform.paths.key(path.dirname(directory)) === platform.paths.key(stateRoot) &&
    platform.paths.key(directory) !== platform.paths.key(path.join(stateRoot, 'scratch'))
  );
}
