import type { Commands } from './index';
import * as shells from './shells';

/**
 * Every consumer here runs a POSIX shell: a brand's native shell is sh too.
 * Also the unchanged, unverified legacy path on other POSIX hosts.
 */
export function commands(): Commands {
  return { shell: () => 'posix', ...shells.grammar };
}
