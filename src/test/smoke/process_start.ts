import * as ownership from './ownership';
import { procStartFor } from '../helpers';

/** The real process start, encoded as the local CLI writes its discovery twin. */
export async function procStart(pid: number | string): Promise<string> {
  const row = (await ownership.readProcesses()).get(Number(pid));
  if (!row) throw new Error(`fixture process ${pid} is absent from the native snapshot`);
  return procStartFor(row.startedAt);
}
