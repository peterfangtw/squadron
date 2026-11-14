import * as crypto from 'node:crypto';
import * as args from './args';
import * as gate from './gate';
import * as help from './help';
import * as inputFile from './input_file';
import * as self from './self';
import * as routines from '../core/routines/routines';

export const FLAGS = ['run-id', 'note'] as const;
const USAGE = 'usage: squadron-routine done --run-id <uuid> [--note <text>]';

async function main(): Promise<void> {
  const argv = await inputFile.argvOrExit('squadron-routine');
  if (
    help.show('routine', USAGE, argv) ||
    (argv[0] === 'done' && help.show('routine', USAGE, argv.slice(1)))
  )
    return;
  const options = args.parseFlags(argv.slice(1), FLAGS);
  if (
    argv[0] !== 'done' ||
    !options ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      options['run-id'] ?? ''
    ) ||
    (options.note?.length ?? 0) > 200
  )
    return die(1, USAGE);
  await gate.refuseUnlessOn('routine');
  const caller = await self.resolveOwnedSelf();
  if (!caller.ok) return die(caller.code, caller.reason);
  let resolved: Awaited<ReturnType<typeof routines.resolveRoutineRun>>;
  try {
    resolved = await routines.resolveRoutineRun(options['run-id'] ?? '');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return die(2, 'No associated routine run was found.');
    return die(5, String(error));
  }
  if (!resolved) return die(2, 'No associated routine run was found.');
  const result = await routines.applyRoutineAction(
    resolved.scope,
    {
      kind: 'done',
      operationId: crypto.randomUUID(),
      runId: options['run-id'] ?? '',
      receiver: caller.receiver,
      note: options.note
    },
    Date.now()
  );
  if (result.kind !== 'ok')
    return die(result.kind === 'io' || result.kind === 'unavailable' ? 5 : 2, result.reason);
  process.stdout.write(`Routine run ${options['run-id']} completed.\n`);
}

function die(code: number, message: string): void {
  process.stderr.write(`squadron-routine: ${message}\n`);
  process.exitCode = code;
}

if (require.main === module) void main().catch((error: unknown) => die(5, String(error)));
