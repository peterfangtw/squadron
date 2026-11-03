import * as platform from '../core/platform';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { BRANDS } from '../core/brands';
import { WINDOWS_DIR } from '../core/coordination/claims';
import { WindowClaim } from '../core/model';

// Reading them is `vscode`-free and lives in `core/coordination/claims.ts`, which the spawn
// CLI shares. Re-exported so callers still have one door for both halves.
export { readClaims } from '../core/coordination/claims';

/**
 * This window's claim: that it is alive, what it is called, the folder it has
 * open, the CLIs it can start and whether Orchestration is on. Other windows
 * and the `squadron-*` shims read it to pick a window to ask, and a claim that
 * stops being refreshed is how a closed window drops out of that list.
 */
export class WindowClaimant implements vscode.Disposable {
  private readonly file = path.join(WINDOWS_DIR, `${vscode.env.sessionId}.json`);
  private timer: NodeJS.Timeout | undefined;
  /** Distinguishes overlapping writes' temp files, so neither corrupts the other. */
  private seq = 0;

  async publish(): Promise<void> {
    await this.write({
      id: vscode.env.sessionId,
      startupAdmission: 1,
      label: vscode.workspace.name ?? '(no folder)',
      app: vscode.env.appName,
      folder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      // This build's own registry, never a hand-written list: a brand that
      // boards gets a directory and a line in `ADAPTERS`, and a window that
      // can start it says so here without anyone remembering to.
      brands: [...BRANDS],
      // Always empty, and still written: a window on an older build rejects a
      // claim without the array (`isClaim`), and would drop this window from
      // every list it draws.
      shellPids: [],
      orchestration: vscode.workspace
        .getConfiguration('squadron')
        .get<boolean>('orchestrators.enabled', false),
      updatedAt: Date.now()
    });
  }

  /**
   * Write to a temp file and rename into place: writeFile truncates first, so a
   * reader that catches it mid-write parses garbage and drops the claim — and
   * for this window that is the "this window" badge blinking out. rename is
   * atomic on one filesystem, so a reader sees the whole old or new file.
   */
  private async write(claim: WindowClaim): Promise<void> {
    const tmp = `${this.file}.${process.pid}.${this.seq++}.tmp`;
    try {
      await fs.mkdir(WINDOWS_DIR, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(claim));
      await platform.files.replace(tmp, this.file, { kind: 'beat' });
    } catch {
      // best effort — the panel degrades to an "unknown window" group
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** Republish on a heartbeat, so the claim stays fresh. */
  start(): void {
    void this.publish();
    this.timer = setInterval(() => void this.publish(), 30_000);
  }

  dispose(): void {
    clearInterval(this.timer);
    void fs.rm(this.file, { force: true });
  }
}

/**
 * This host's own command-line launcher, read rather than written down: the
 * binary is named after whatever fork we are running in, and a hardcoded name
 * or install path in `src/` is the repo rule this exists to keep.
 *
 * Out here rather than inline because it is read for the extension development
 * host a group's servers section can start, and was read to raise another
 * window before the jump-to-terminal path went.
 */
export async function ideCliPath(): Promise<string | undefined> {
  try {
    const product = JSON.parse(
      await fs.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8')
    ) as { applicationName?: string };
    return product.applicationName
      ? path.join(vscode.env.appRoot, 'bin', product.applicationName)
      : undefined;
  } catch {
    return undefined;
  }
}
