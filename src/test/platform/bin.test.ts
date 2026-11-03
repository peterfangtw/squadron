import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { before, describe, it } from 'node:test';
import { claudeBinary, codexBinary, grokBinary, type BinaryFound } from '../../core/bin';
import { executableEffects } from '../../core/platform';
import type { Executables, Search } from '../../core/platform/executables';
import * as darwin from '../../core/platform/executables/darwin';
import { tempHome } from '../helpers';

/** POSIX's rules on whichever host runs the suite; win32's are
 *  `executables.test.ts`'s. */
const POSIX = darwin.executables(executableEffects);

/** A found binary as its log line states it; what it runs is the capability's. */
function shown(found: BinaryFound | { ok: false; reason: string }): unknown {
  return found.ok ? { ok: true, path: found.path, source: found.source } : found;
}

let home: string;
/** Somewhere off `PATH` and off `~`, for the explicit-setting cases. */
let elsewhere: string;

/** A file that runs, or one that only looks like it. */
async function put(dir: string, name: string, mode = 0o755): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, '#!/bin/sh\necho hi\n', { mode });
  await fs.chmod(file, mode);
  return file;
}

before(async () => {
  home = await tempHome();
  elsewhere = path.join(home, 'elsewhere');
});

describe('claudeBinary', () => {
  it('takes the setting over anything it would have found', async () => {
    await put(path.join(home, '.local/bin'), 'claude');
    const named = await put(elsewhere, 'claude-2.2');
    const found = await claudeBinary(named, { PATH: '/usr/bin' }, POSIX);
    assert.deepEqual(shown(found), { ok: true, path: named, source: 'setting' });
  });

  it('expands a leading ~, which is what a person types into a settings box', async () => {
    const file = await put(path.join(home, 'tools'), 'claude');
    const found = await claudeBinary('~/tools/claude', {}, POSIX);
    assert.equal(found.ok && found.path, file);
  });

  it('refuses a setting that does not resolve, rather than searching on', async () => {
    // Quietly running a different binary than the one someone named is worse
    // than not starting — naming it usually means the search finds the wrong one.
    await put(path.join(home, '.local/bin'), 'claude');
    const found = await claudeBinary(path.join(elsewhere, 'nope'), {}, POSIX);
    assert.equal(found.ok, false);
    assert.match(found.ok ? '' : found.reason, /settings/);
    assert.match(found.ok ? '' : found.reason, /nope/);
  });

  it('finds the installer’s own path when no setting names one', async () => {
    const file = await put(path.join(home, '.local/bin'), 'claude');
    const found = await claudeBinary(undefined, { PATH: '/usr/bin:/bin' }, POSIX);
    assert.deepEqual(shown(found), { ok: true, path: file, source: 'home' });
  });

  it('prefers the installer’s path to PATH', async () => {
    // The well-known path is where the CLI puts itself; a PATH entry is
    // whatever else on the machine answers to the name.
    const installed = await put(path.join(home, '.local/bin'), 'claude');
    const other = path.join(home, 'a');
    await put(other, 'claude');
    const found = await claudeBinary(undefined, { PATH: other }, POSIX);
    assert.equal(found.ok && found.path, installed);
  });

  it('refuses with somewhere to go when there is nothing to find', async () => {
    await fs.rm(path.join(home, '.local'), { recursive: true, force: true });
    const found = await claudeBinary(undefined, { PATH: '/nowhere/at/all' }, POSIX);
    assert.equal(found.ok, false);
    assert.match(found.ok ? '' : found.reason, /squadron\.claudePath/);
  });

  it('says why a file it found cannot start, and which setting to fix', async () => {
    // The refusal is the capability's sentence; the setting is this brand's.
    const refused = 'C:\\npm\\claude.cmd runs its script with `node`, which is nowhere.';
    const answering = (search: Search): Executables => ({
      ...POSIX,
      find: () => Promise.resolve(search)
    });
    const missing = await claudeBinary(undefined, {}, answering({ kind: 'missing', refused }));
    assert.deepEqual(missing, {
      ok: false,
      reason:
        `${refused} Looked in ~/.local/bin and on this process’s PATH — set ` +
        '`squadron.claudePath` to an executable it can start.'
    });
    const setting = await claudeBinary(
      'C:\\npm\\claude.cmd',
      {},
      answering({ kind: 'setting', file: 'C:\\npm\\claude.cmd', refused })
    );
    assert.deepEqual(setting, {
      ok: false,
      reason: `The \`claude\` path in settings cannot be started: ${refused}`
    });
  });
});

describe('grokBinary', () => {
  it('finds the installer symlink under ~/.grok/bin', async () => {
    const file = await put(path.join(home, '.grok/bin'), 'grok');
    const found = await grokBinary(undefined, { PATH: '/usr/bin:/bin' }, POSIX);
    assert.deepEqual(shown(found), { ok: true, path: file, source: 'home' });
  });

  it('falls back to PATH when the installer path is missing', async () => {
    await fs.rm(path.join(home, '.grok'), { recursive: true, force: true });
    const dir = path.join(home, 'path-grok');
    const file = await put(dir, 'grok');
    const found = await grokBinary(undefined, { PATH: dir }, POSIX);
    assert.deepEqual(shown(found), { ok: true, path: file, source: 'path' });
  });

  it('refuses an explicit path that is not executable', async () => {
    await put(path.join(home, '.grok/bin'), 'grok');
    const found = await grokBinary(path.join(elsewhere, 'nope'), {}, POSIX);
    assert.equal(found.ok, false);
    assert.match(found.ok ? '' : found.reason, /settings/);
    assert.match(found.ok ? '' : found.reason, /nope/);
  });

  it('refuses a missing binary with the Grok setting to fix', async () => {
    await fs.rm(path.join(home, '.grok'), { recursive: true, force: true });
    const found = await grokBinary(undefined, { PATH: '/nowhere/at/all' }, POSIX);
    assert.equal(found.ok, false);
    assert.match(found.ok ? '' : found.reason, /squadron\.grokPath/);
  });
});

describe('codexBinary', () => {
  it('finds the standalone installer symlink under ~/.local/bin', async () => {
    const file = await put(path.join(home, '.local/bin'), 'codex');
    const found = await codexBinary(undefined, { PATH: '/usr/bin:/bin' }, POSIX);
    assert.deepEqual(shown(found), { ok: true, path: file, source: 'home' });
  });

  it('falls back to PATH when the installer path is missing', async () => {
    await fs.rm(path.join(home, '.local/bin/codex'), { force: true });
    const dir = path.join(home, 'path-codex');
    const file = await put(dir, 'codex');
    const found = await codexBinary(undefined, { PATH: dir }, POSIX);
    assert.deepEqual(shown(found), { ok: true, path: file, source: 'path' });
  });

  it('refuses an explicit path rather than searching past it', async () => {
    await put(path.join(home, '.local/bin'), 'codex');
    const found = await codexBinary(path.join(elsewhere, 'nope'), {}, POSIX);
    assert.equal(found.ok, false);
    assert.match(found.ok ? '' : found.reason, /settings/);
    assert.match(found.ok ? '' : found.reason, /nope/);
  });

  it('refuses a missing binary with the Codex setting to fix', async () => {
    await fs.rm(path.join(home, '.local/bin/codex'), { force: true });
    const found = await codexBinary(undefined, { PATH: '/nowhere/at/all' }, POSIX);
    assert.equal(found.ok, false);
    assert.match(found.ok ? '' : found.reason, /squadron\.codexPath/);
  });
});
