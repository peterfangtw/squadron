import type { Commands } from './index';
import * as shells from './shells';

/**
 * A brand's native shell is Windows PowerShell 5.1: Codex 0.163.0's and Grok
 * 1.0.70's tool and hook commands ran under `WindowsPowerShell\v1.0\
 * powershell.exe` (observed 2026-10-25/27). A POSIX consumer is Git Bash.
 */
export function commands(): Commands {
  return {
    shell: (family) => (family === 'native' ? 'windows-powershell' : 'posix'),
    ...shells.grammar,
    // A native parent handing -c text to MSYS bash halves doubled backslashes
    // before shell parsing (2026-10-27); MSYS_NO_PATHCONV cannot repair that hop.
    carries: (program, args, shell) =>
      shell === 'posix'
        ? ![
            program,
            ...args.map((arg) =>
              typeof arg === 'object' ? `${arg.option}=${arg.value}` : String(arg)
            )
          ].some((value) => value.includes('\\\\'))
        : shells.grammar.carries(program, args, shell)
  };
}
