import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { repoRoot } from '../helpers';

/**
 * The messenger seam, held the way the panel's tooltip rule is: from source,
 * since a seam is a property of what a file names, and nothing at runtime
 * notices the first wire word that leaks above the adapter.
 *
 * `core/bridge/` is the messenger-free core. A messenger's wire lives in its
 * own sibling package, and the core reaches it only through the registry in
 * `port.ts`, the way `core/adapter.ts` reaches the brands.
 */
describe('the messenger seam', () => {
  const dir = path.join(repoRoot(), 'src', 'core', 'bridge');

  /** Every messenger the capabilities file compared, and the wire words of
   *  the one being built first: its thread key, its markup and its two token
   *  prefixes. Case-folded, so a comment is held to it as well as code. */
  const NAMES = [
    /slack/i,
    /telegram/i,
    /discord/i,
    /thread_ts/i,
    /mrkdwn/i,
    /block ?kit/i,
    /callback_data/i,
    /xox[abp]/i,
    /xapp/i
  ];

  /**
   * The registry, and nothing else: the import of a messenger's package and
   * its one entry in `MESSENGERS`. Trimmed, with a trailing comma dropped, so
   * the entry passes wherever it sits in the record.
   */
  const REGISTRY: Readonly<Record<string, readonly string[]>> = {
    'port.ts': ["import * as slack from '../slack/messenger';", 'slack: slack.slackEntry']
  };

  const walk = (at: string): string[] =>
    fs.readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(at, entry.name);
      return entry.isDirectory() ? walk(full) : entry.name.endsWith('.ts') ? [full] : [];
    });

  it('names no messenger and no messenger’s wire outside the registry', () => {
    const files = walk(dir);
    assert.ok(files.length > 0, 'the core has files to check');
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(dir, file);
      const allowed = REGISTRY[rel] ?? [];
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (allowed.includes(line.trim().replace(/,$/, ''))) return;
          if (NAMES.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        });
    }
    assert.deepEqual(offenders, []);
  });
});
