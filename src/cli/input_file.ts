import * as platform from '../core/platform';
import * as files from '../core/platform/files';

/**
 * A file an agent wrote for a verb to read: `--answers-file`, `--argv-file`.
 * Neither cmd nor Windows PowerShell 5.1 can hand a `.cmd` a line break or a
 * `"`, and a file the agent's own write tool made carries both.
 *
 * MAX_TEXT allows 16,000 code units; six-byte JSON escapes plus structure fit
 * in 96 KiB.
 */
export const INPUT_FILE_MAX_BYTES = 96 * 1024;

/**
 * A regular file, at most {@link INPUT_FILE_MAX_BYTES} including one optional
 * initial UTF-8 BOM, read as strict UTF-8 text without it. Throws an `Error` whose
 * message says why; the file is closed before it returns.
 */
export async function readInputText(file: string): Promise<string> {
  const bytes = await platform.files
    .readRegular(file, INPUT_FILE_MAX_BYTES)
    .catch((error: unknown) => {
      if (error instanceof files.ReadLimitExceeded) throw new Error(`${error.message} (96 KiB)`);
      throw error;
    });
  // Fatal decoding rejects invalid UTF-8; the decoder consumes one initial BOM.
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const ARGV_FILE = '--argv-file';

/**
 * The verb's arguments: as given, or — when the whole command line is
 * `--argv-file <path>` — the JSON array of strings that file holds. Every
 * verb reads this before its own parse, so the file's arguments meet the same
 * usage, guards and refusals as typed ones. Exclusive and one level deep: an
 * `--argv-file` beside other arguments, or inside the file, is refused.
 */
export async function commandArgv(
  raw: readonly string[]
): Promise<{ ok: true; argv: readonly string[] } | { ok: false; reason: string }> {
  const named = (arg: string) => arg === ARGV_FILE || arg.startsWith(`${ARGV_FILE}=`);
  if (!raw.some(named)) return { ok: true, argv: raw };
  const [flag, file, ...rest] = raw;
  if (flag !== ARGV_FILE || file === undefined || rest.length > 0) {
    return { ok: false, reason: `${ARGV_FILE} <path> must be the only arguments` };
  }
  try {
    const value: unknown = JSON.parse(await readInputText(file));
    if (!Array.isArray(value) || !value.every((arg) => typeof arg === 'string')) {
      throw new Error('must hold a JSON array of strings');
    }
    if (value.some(named)) throw new Error(`cannot name ${ARGV_FILE} again`);
    return { ok: true, argv: value };
  } catch (error) {
    return {
      ok: false,
      reason: `${ARGV_FILE}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/** {@link commandArgv} for a verb's `main`: a refused file is usage, exit 1, before any state is read. */
export async function argvOrExit(verb: string): Promise<readonly string[]> {
  const read = await commandArgv(process.argv.slice(2));
  if (read.ok) return read.argv;
  process.stderr.write(`${verb}: ${read.reason}\n`);
  process.exit(1);
}
