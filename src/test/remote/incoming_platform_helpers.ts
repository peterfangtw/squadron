import * as fs from 'node:fs/promises';
import * as cp from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as win32 from '../../core/platform/private_files/win32';
import { repoRoot, testPlatform, resetDir, disposeHome } from '../helpers';

let permissionFixture: string | undefined;
export const INCOMING_TEST_MS = testPlatform() === 'win32' ? 60000 : 10000;

/** Own the fixture home, candidate artifact and host process-reader lease. */
export async function incomingPlatformFixture(home: string): Promise<() => Promise<void>> {
  if (testPlatform() !== 'win32') return () => disposeHome(home);
  const platform = await import('../../core/platform');
  const manifest = JSON.parse(
    await fs.readFile(path.join(repoRoot(), 'dist/helpers/private-files-v1.json'), 'utf8')
  ) as { sha256: string };
  const files = win32.privateFiles({
    artifact: () =>
      Promise.resolve({
        executable: path.join(repoRoot(), 'dist/helpers/private-files-v1.exe'),
        sha256: manifest.sha256
      }),
    tmpdir: () => os.tmpdir()
  });
  const original = { ...platform.privateFiles };
  Object.assign(platform.privateFiles, files);
  const reader = platform.processes.own();
  return async () => {
    const fixture = permissionFixture;
    permissionFixture = undefined;
    const results = await Promise.allSettled([
      files.dispose(),
      fixture ? resetDir(path.dirname(fixture)) : Promise.resolve(),
      reader.dispose().then((closed) => {
        if (closed.unresolved.length)
          throw new Error(`fixture reader not closed: ${closed.unresolved.join(', ')}`);
      })
    ]);
    Object.assign(platform.privateFiles, original);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : []
    );
    if (errors.length)
      throw new AggregateError(errors, 'incoming platform fixture disposal failed');
    await disposeHome(home);
  };
}

export async function privatePermissions(file: string, privateAccess: boolean): Promise<void> {
  if (testPlatform() !== 'win32') return fs.chmod(file, privateAccess ? 0o600 : 0o644);
  if (!permissionFixture) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'private-permissions-'));
    permissionFixture = path.join(directory, 'fixture.exe');
    cp.execFileSync(
      path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      [
        '/nologo',
        '/target:exe',
        '/platform:anycpu',
        '/main:PrivateFilesFixture',
        `/out:${permissionFixture}`,
        path.join(repoRoot(), 'src/test/fixtures/private_files_native.cs'),
        path.join(repoRoot(), 'src/core/platform/private_files/helper/Program.cs')
      ],
      { windowsHide: true, timeout: 30000 }
    );
  }
  cp.execFileSync(
    permissionFixture,
    ['file', file, privateAccess ? 'D:P(A;;FA;;;USER)' : 'D:P(A;;FA;;;USER)(A;;FR;;;WD)'],
    { windowsHide: true, timeout: 5000 }
  );
}

export async function resetPrivateFiles(): Promise<void> {
  const platform = await import('../../core/platform');
  const located = await platform.privateFiles.dir();
  if (!located.supported || located.status !== 'ok')
    throw new Error('private-file fixture root unavailable');
  await resetDir(located.value);
}
