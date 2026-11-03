import * as ownership from './ownership';

export async function registerLaunch(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const socket = env['SQUADRON_SMOKE_SOCKET'];
  const token = env['SQUADRON_SMOKE_TOKEN'];
  const launch = env['SQUADRON_SMOKE_LAUNCH'];
  if (!socket || !token || !launch) throw new Error('launcher requires smoke ownership');
  await ownership.request(socket, {
    type: 'register',
    token,
    launch,
    pid: process.ppid,
    helper: process.pid
  });
}

if (require.main === module) {
  registerLaunch().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
