import * as os from 'os';
import * as vscode from 'vscode';
import { adapter } from '../core/adapter';
import { BRANDS } from '../core/brands';
import { SkillDiscovery, type SkillNames } from '../core/skills';
import type { Session } from '../core/model';

let discovery: SkillDiscovery | undefined;
let initialized: Promise<void> = Promise.resolve();

export function startSkillDiscovery(
  installed: Promise<void>,
  changed: () => void,
  log: (message: string) => void
): vscode.Disposable {
  let active = true;
  let current: SkillDiscovery | undefined;
  const update = (): void => {
    const catalog = current;
    if (!catalog) return;
    void catalog
      .setWorkspaces((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath))
      .then(() => {
        if (active && discovery === catalog) changed();
      })
      .catch((error: unknown) => log(`skill discovery: ${String(error)}`));
  };
  const folders = vscode.workspace.onDidChangeWorkspaceFolders(update);
  initialized = installed
    .catch((error: unknown) => log(`skill install: ${String(error)}`))
    .then(() => {
      if (!active) return;
      current = new SkillDiscovery(
        BRANDS.flatMap((brand) => adapter(brand) ?? []),
        os.homedir(),
        process.env,
        () => {
          if (active && discovery === current) changed();
        }
      );
      discovery = current;
      update();
    });
  return new vscode.Disposable(() => {
    active = false;
    folders.dispose();
    current?.dispose();
    if (discovery === current) discovery = undefined;
  });
}

export async function refreshSkills(): Promise<void> {
  await initialized;
  await discovery?.refresh();
}

export async function skillsForSession(session: Session): Promise<readonly string[]> {
  return discovery?.forSession(session) ?? [];
}

export async function skillsByDirectory(
  cwds: readonly string[]
): Promise<ReadonlyMap<string, SkillNames>> {
  const catalog = discovery;
  if (!catalog) return new Map();
  return new Map(
    await Promise.all(
      [...new Set(cwds)].map(async (cwd) => [cwd, await catalog.forCwd(cwd)] as const)
    )
  );
}

export function allSkills(): readonly string[] {
  return discovery?.union() ?? [];
}
